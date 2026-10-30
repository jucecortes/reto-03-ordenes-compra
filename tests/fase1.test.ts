import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { contieneAprobado } from "../src/domain/aprobacion.ts"
import { leerPaquete } from "../src/fixtures/lector.ts"
import { parsearCotizacion, parsearFactura } from "../src/schemas/parsers.ts"
import { aCentavos, fechaBogota, normalizarNit, normalizarNombre, parsearPesos } from "../src/schemas/valores.ts"

const raiz = path.resolve(import.meta.dir, "..")

describe("valores", () => {
  test("pesos y centavos", () => {
    expect(parsearPesos("COP 11.400.000")).toBe(11_400_000)
    expect(parsearPesos("1.234,56")).toBe(1234.56)
    expect(aCentavos(11_400_000)).toBe(1_140_000_000)
    expect(() => parsearPesos("COP abc")).toThrow()
  })
  test("fecha en Bogotá de un ISO con hora", () => {
    expect(fechaBogota("2026-08-26T18:45:00-05:00")).toBe("2026-08-26")
    expect(fechaBogota("2026-08-27T03:00:00Z")).toBe("2026-08-26")
    expect(fechaBogota("2026-08-20")).toBe("2026-08-20")
  })
  test("NIT y nombre normalizados", () => {
    expect(normalizarNit("900.555.111-2")).toBe("900555111")
    expect(normalizarNit("900555111")).toBe("900555111")
    expect(normalizarNombre("Papelería Central Ltda.")).toBe("papeleriacentralltda")
    expect(normalizarNombre("TecnoSuministros S.A.S.")).toBe(normalizarNombre("tecnosuministros sas"))
  })
})

describe("contieneAprobado (A4)", () => {
  test.each([
    ["Aprobado, proceder con la orden de compra.", true],
    ["Aprobado desde comercial, es para el equipo de preventa", true],
    ["aprobada la compra", true],
    ["No aprobado por falta de presupuesto", false],
    ["Pendiente de revisión", false],
    ["Desaprobado", false],
  ])("%s → %p", (texto, esperado) => expect(contieneAprobado(texto)).toBe(esperado))
})

describe("parsers", () => {
  test("cotización de sol-004", async () => {
    const texto = await Bun.file(path.join(raiz, "fixtures/reto-03/solicitudes/sol-004/cotizacion.txt")).text()
    const r = parsearCotizacion(texto)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data).toMatchObject({
      referencia: "CA-2026-0310",
      fecha: "2026-08-25",
      proveedor: "Cloud Andina S.A.S.",
      nit: "901222333",
      total: 26_500_000,
      base: 22_268_908,
      iva: 4_231_092,
      tasa_iva: 0.19,
      moneda: "COP",
      validez_hasta: "2026-09-14",
    })
    expect(r.data.items).toEqual([
      { numero: 1, descripcion: "Hora de arquitecto de nube senior", cantidad: 100, precio_unitario: 265_000, subtotal: 26_500_000 },
    ])
  })
  test("factura de sol-005", async () => {
    const texto = await Bun.file(path.join(raiz, "fixtures/reto-03/solicitudes/sol-005/factura.txt")).text()
    expect(parsearFactura(texto)).toEqual({ ok: true, data: { numero: "FC-88231", fecha: "2026-08-10", total: 3_200_000, nit: "800444555" } })
  })
  test("CRLF produce el mismo resultado", async () => {
    const texto = await Bun.file(path.join(raiz, "fixtures/reto-03/solicitudes/sol-001/cotizacion.txt")).text()
    const lf = parsearCotizacion(texto.replace(/\r\n/g, "\n"))
    const crlf = parsearCotizacion(texto.replace(/\r?\n/g, "\r\n"))
    expect(crlf.ok && lf.ok && crlf.data.total === lf.data.total).toBe(true)
  })
  test("texto no reconocido → error legible, sin lanzar", () => {
    expect(parsearCotizacion("Adjunto PDF escaneado")).toMatchObject({ ok: false })
    expect(parsearFactura("hola")).toMatchObject({ ok: false })
  })
})

describe("leerPaquete (HU-1, HU-6)", () => {
  test("sol-006: campos opcionales ausentes y sin factura", async () => {
    const r = await leerPaquete(raiz, "sol-006")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.solicitud.proveedor_nit).toBeUndefined()
    expect(r.data.solicitud.indicador_iva).toBeUndefined()
    expect(r.data.factura).toBeNull()
    expect(r.data.faltantes).toEqual([])
  })
  test("caso inválido o con path traversal", async () => {
    expect(await leerPaquete(raiz, "../maestros")).toMatchObject({ ok: false })
    expect(await leerPaquete(raiz, "sol-999")).toMatchObject({ ok: false })
  })

  const tmp = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "reto03-"))
    const caso = path.join(dir, "fixtures/reto-03/solicitudes/sol-900")
    mkdirSync(caso, { recursive: true })
    return { dir, caso }
  }

  test("adjunto ausente → null con su nombre, sin excepción", async () => {
    const { dir, caso } = tmp()
    writeFileSync(
      path.join(caso, "solicitud.json"),
      JSON.stringify({
        solicitud_id: "X",
        solicitante: "Y",
        proveedor_nombre: "Z",
        descripcion: "d",
        centro_costo: "CC-1010",
        subarea: "Soporte",
        cantidad: 1,
        valor_unitario: 10,
        valor_total: 10,
        moneda: "COP",
        fecha_solicitud: "2026-08-01",
      }),
    )
    const r = await leerPaquete(dir, "sol-900")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.cotizacion).toBeNull()
    expect(r.data.aprobacion).toBeNull()
    expect(r.data.faltantes.map((f) => f.adjunto)).toEqual(["correo.json", "cotizacion.txt", "aprobacion.json"])
  })
  test("JSON malformado y monto no numérico → { ok: false, error } legible", async () => {
    const { dir, caso } = tmp()
    writeFileSync(path.join(caso, "solicitud.json"), "{ esto no es json")
    expect(await leerPaquete(dir, "sol-900")).toMatchObject({ ok: false, error: expect.stringContaining("JSON malformado") })
    writeFileSync(path.join(caso, "solicitud.json"), JSON.stringify({ valor_total: "once millones" }))
    const r = await leerPaquete(dir, "sol-900")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("valor_total")
  })
})
