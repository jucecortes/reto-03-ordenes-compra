import { beforeAll, describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { etiqueta, evaluar } from "../src/domain/evaluar.ts"
import { construirPayload, derivarUnidad, truncarDescripcion } from "../src/domain/payload.ts"
import { calcularImpuestos } from "../src/domain/reglas.ts"
import { leerMaestros, leerPaquete } from "../src/fixtures/lector.ts"
import type { Maestros } from "../src/schemas/maestros.ts"
import type { Paquete } from "../src/schemas/paquete.ts"
import { ejecutarHerramienta, reiniciarEstado, type Contexto } from "../src/tools/oc.ts"

const raiz = path.resolve(import.meta.dir, "..")
let maestros: Maestros
let base: Paquete // sol-001: apto, sin excepciones

beforeAll(async () => {
  const m = await leerMaestros(raiz)
  const p = await leerPaquete(raiz, "sol-001")
  if (!m.ok || !p.ok) throw new Error("no se pudieron cargar los fixtures")
  maestros = m.data
  base = p.data
})

/** Variante de sol-001 con cambios en la solicitud u otras piezas del paquete. */
const variante = (sol: Partial<Paquete["solicitud"]>, resto: Partial<Paquete> = {}): Paquete => ({
  ...base,
  ...resto,
  solicitud: { ...base.solicitud, ...sol },
})
const codigos = (p: Paquete) => {
  const e = evaluar(p, maestros)
  return { bloqueos: e.bloqueos.map(etiqueta), confirmaciones: e.confirmaciones.map(etiqueta), apta: e.apta, retroactiva: e.retroactiva }
}

describe("RC3 · tope del aprobador", () => {
  test("tope exacto cumple (≤): mlopez tiene tope 50.000.000", () => {
    expect(codigos(variante({ cantidad: 1, valor_unitario: 50_000_000, valor_total: 50_000_000 })).bloqueos).toEqual([])
  })
  test("un peso sobre el tope bloquea", () => {
    expect(codigos(variante({ cantidad: 1, valor_unitario: 50_000_001, valor_total: 50_000_001 })).bloqueos).toContain("RC3:MONTO_SUPERA_TOPE")
  })
})

describe("RC1 · proveedor", () => {
  test("proveedor inactivo bloquea", () => {
    expect(codigos(variante({ proveedor_nit: "901777888", proveedor_nombre: "Consultores Ágiles S.A.S." })).bloqueos).toEqual(["RC1:PROVEEDOR_INACTIVO"])
  })
  test("sin NIT se busca por nombre normalizado (tildes, mayúsculas y puntuación)", () => {
    expect(codigos(variante({ proveedor_nit: undefined, proveedor_nombre: "  tecnosuministros SAS " })).bloqueos).toEqual([])
  })
  test("con NIT inexistente no se recurre al nombre (A2)", () => {
    expect(codigos(variante({ proveedor_nit: "999999999" })).bloqueos).toEqual(["RC1:PROVEEDOR_NO_ENCONTRADO"])
  })
  test("NIT con puntos y DV se normaliza", () => {
    expect(codigos(variante({ proveedor_nit: "900.555.111-2" })).bloqueos).toEqual([])
  })
})

describe("RC2 · aprobación", () => {
  test("sin aprobación bloquea", () => {
    expect(codigos(variante({}, { aprobacion: null })).bloqueos).toEqual(["RC2:APROBACION_AUSENTE"])
  })
  test("'No aprobado' bloquea", () => {
    expect(codigos(variante({}, { aprobacion: { ...base.aprobacion!, texto: "No aprobado.", aprobado: false } })).bloqueos).toEqual([
      "RC2:APROBACION_SIN_APROBADO",
    ])
  })
})

describe("RC4 · subárea", () => {
  test("subárea de otro centro bloquea", () => {
    expect(codigos(variante({ subarea: "Compras" })).bloqueos).toEqual(["RC4:SUBAREA_NO_PERTENECE"])
  })
  test("centro inexistente bloquea (y el aprobador no tiene autoridad en él)", () => {
    expect(codigos(variante({ centro_costo: "CC-9999" })).bloqueos).toEqual([
      "RC2:APROBADOR_NO_AUTORIZADO",
      "RC3:APROBADOR_SIN_TOPE",
      "RC4:CENTRO_COSTO_INEXISTENTE",
    ])
  })
})

describe("RC5 · cotización vs solicitud", () => {
  const conTotal = (total: number) => variante({}, { cotizacion: { ...base.cotizacion!, total } })
  test("exactamente 2 % cumple", () => expect(codigos(conTotal(11_628_000)).confirmaciones).toEqual([]))
  test("un peso sobre el 2 % pide confirmación", () => expect(codigos(conTotal(11_628_001)).confirmaciones).toEqual(["RC5:DIFERENCIA_COTIZACION"]))
  test("sin cotización pide confirmación", () => expect(codigos(variante({}, { cotizacion: null })).confirmaciones).toEqual(["RC5:COTIZACION_AUSENTE"]))
})

describe("RC6 y RC7 · derivados", () => {
  test("sin IVA ni condición: deriva ambos; solo el IVA pide confirmación", () => {
    const e = evaluar(variante({ indicador_iva: undefined, condiciones_pago: undefined }), maestros)
    expect(e.derivados).toEqual({ indicador_iva: "C1", condiciones_pago: "Z030" })
    expect(e.confirmaciones.map(etiqueta)).toEqual(["RC6:IVA_DERIVADO"])
    expect(e.bloqueos).toEqual([])
  })
  test("indicador inexistente en el maestro bloquea (A10)", () => {
    expect(codigos(variante({ indicador_iva: "C9" })).bloqueos).toEqual(["RC6:IVA_INDICADOR_DESCONOCIDO"])
  })
})

describe("RC8 · retroactiva", () => {
  const factura = (fecha: string) => ({ numero: "F-1", fecha, total: 11_400_000, nit: "900555111" })
  test("sin factura no es retroactiva", () => expect(codigos(base).retroactiva).toBe(false))
  test("factura del mismo día de la solicitud no es retroactiva (< estricto)", () => {
    expect(codigos(variante({}, { factura: factura("2026-08-20") })).retroactiva).toBe(false)
  })
  test("factura del día anterior es retroactiva y pide confirmación", () => {
    const c = codigos(variante({}, { factura: factura("2026-08-19") }))
    expect(c.retroactiva).toBe(true)
    expect(c.confirmaciones).toEqual(["RC8:COMPRA_RETROACTIVA"])
  })
})

describe("RC9 · fecha de aprobación (zona Bogotá)", () => {
  const aprobadaEl = (fecha: string) => variante({}, { aprobacion: { ...base.aprobacion!, fecha } })
  test("mismo día por la noche cumple", () => expect(codigos(aprobadaEl("2026-08-20T23:30:00-05:00")).confirmaciones).toEqual([]))
  test("03:00 UTC del 20 es el 19 en Bogotá → confirmación", () => {
    expect(codigos(aprobadaEl("2026-08-20T03:00:00Z")).confirmaciones).toEqual(["RC9:APROBACION_ANTERIOR_A_SOLICITUD"])
  })
})

describe("RC10 · cantidad × valor unitario", () => {
  test("diferencia de 1 peso cumple", () => expect(codigos(variante({ valor_total: 11_400_001 })).bloqueos).not.toContain("RC10:TOTAL_INCONSISTENTE"))
  test("diferencia de 2 pesos bloquea", () => expect(codigos(variante({ valor_total: 11_400_002 })).bloqueos).toContain("RC10:TOTAL_INCONSISTENTE"))
})

describe("payload", () => {
  test("IVA: desglose en centavos con redondeo documentado", () => {
    expect(calcularImpuestos(11_400_000, 0.19)).toEqual({ total: 11_400_000, base: 9_579_831.93, iva: 1_820_168.07, tasa: 0.19 })
  })
  test("descripción a 40 caracteres sin cortar palabras", () => {
    const d = truncarDescripcion(base.solicitud.descripcion)
    expect(d).toBe("Renovación licencias antivirus")
    expect(d.length).toBeLessThanOrEqual(40)
  })
  test("unidad H para ítems por hora", async () => {
    const p = await leerPaquete(raiz, "sol-004")
    expect(p.ok && derivarUnidad(p.data.cotizacion)).toBe("H")
    expect(derivarUnidad(base.cotizacion)).toBe("UN")
  })
  test("no se construye payload con bloqueos", () => {
    const p = variante({ subarea: "Compras" })
    expect(construirPayload(p, evaluar(p, maestros), maestros).ok).toBe(false)
  })
})

describe("herramientas (contrato PRD §6.2)", () => {
  let ctx: Contexto
  beforeAll(() => {
    const dir = mkdtempSync(path.join(tmpdir(), "reto03-tools-"))
    cpSync(path.join(raiz, "fixtures"), path.join(dir, "fixtures"), { recursive: true })
    reiniciarEstado()
    ctx = { directory: dir, sessionId: "test" }
  })
  const llamar = async (nombre: string, args: unknown) => JSON.parse(await ejecutarHerramienta(nombre, args, ctx))

  test("argumentos inválidos y herramientas desconocidas devuelven { ok: false }, nunca lanzan", async () => {
    expect(await llamar("oc_validar", { caso: 42 })).toMatchObject({ ok: false })
    expect(await llamar("oc_borrar_todo", {})).toMatchObject({ ok: false })
    expect(await llamar("oc_leer_paquete", { caso: "../../etc" })).toMatchObject({ ok: false })
  })

  test("payload alterado por el modelo se rechaza", async () => {
    const p = await llamar("oc_construir_payload", { caso: "sol-004" })
    const alterado = structuredClone(p.data.orden)
    alterado.posiciones[0].precio_unitario = 265_000 // "arreglar" el monto para que cuadre con la cotización
    const r = await llamar("oc_crear", { caso: "sol-004", payload: alterado, confirmado: true })
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("no coincide") })
  })

  test("con confirmaciones, sin confirmado=true queda pendiente; con true se crea; repetir es idempotente", async () => {
    const p = await llamar("oc_construir_payload", { caso: "sol-006" })
    expect(await llamar("oc_crear", { caso: "sol-006", payload: p.data.orden })).toMatchObject({
      ok: false,
      error: expect.stringContaining("Requiere confirmación"),
    })
    const creada = await llamar("oc_crear", { caso: "sol-006", payload: p.data.orden, confirmado: true })
    expect(creada).toMatchObject({ ok: true, data: { idempotente: false } })
    const otra = await llamar("oc_crear", { caso: "sol-006", payload: p.data.orden, confirmado: true })
    expect(otra).toMatchObject({ ok: true, data: { numero_oc: creada.data.numero_oc, idempotente: true } })
  })

  test("la OC guardada lleva quién confirmó, la evidencia y la trazabilidad", async () => {
    const lineas = readFileSync(path.join(ctx.directory, "out/sap/ordenes.jsonl"), "utf-8").trim().split("\n")
    const orden = JSON.parse(lineas.at(-1)!).orden
    expect(orden.excepciones).toEqual([expect.objectContaining({ codigo: "RC6:IVA_DERIVADO", confirmado_por: "analista (sesión test)" })])
    const evidencia = readFileSync(path.join(ctx.directory, "out/sol-006/aprobacion.txt"), "utf-8")
    expect(evidencia).toContain("De: mlopez@periferia-ficticia.com")
    const traz = JSON.parse(readFileSync(path.join(ctx.directory, "out/sol-006/trazabilidad.json"), "utf-8"))
    expect(traz["posiciones[0].indicador_iva"]).toMatchObject({ valor: "C1", fuente: "maestro.proveedores" })
  })

  test("cada llamada queda en out/log.jsonl (CA4)", () => {
    const log = readFileSync(path.join(ctx.directory, "out/log.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l))
    expect(log.length).toBeGreaterThan(5)
    expect(log[0]).toMatchObject({ sessionId: "test", herramienta: expect.stringMatching(/^oc_/) })
  })
})
