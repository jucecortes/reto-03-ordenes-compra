import { beforeAll, describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sha256 } from "../src/domain/evidencia.ts"
import { ejecutarHerramienta, reiniciarEstado, type Contexto } from "../src/tools/oc.ts"

// Verificación directa de requisitos del PRD que no cubren las pruebas de reglas.
const raiz = path.resolve(import.meta.dir, "..")
let ctx: Contexto
const llamar = async (nombre: string, args: unknown) => JSON.parse(await ejecutarHerramienta(nombre, args, ctx))

beforeAll(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "reto03-req-"))
  cpSync(path.join(raiz, "fixtures"), path.join(dir, "fixtures"), { recursive: true })
  cpSync(path.join(raiz, "ejemplos"), path.join(dir, "ejemplos"), { recursive: true })
  reiniciarEstado()
  ctx = { directory: dir, sessionId: "req" }
})

describe("HU-4 · evidencia de aprobación", () => {
  test("P0: aprobacion.txt con encabezados (de, para, fecha, asunto), cuerpo y sha256 del contenido", async () => {
    const r = await llamar("oc_generar_evidencia", { caso: "sol-001" })
    expect(r).toMatchObject({ ok: true, data: { ruta: "out/sol-001/aprobacion.txt", ruta_pdf: "out/sol-001/aprobacion.pdf" } })
    const txt = readFileSync(path.join(ctx.directory, r.data.ruta), "utf-8")
    for (const encabezado of ["De: mlopez@periferia-ficticia.com", "Para: juan.camargo@periferia-ficticia.com", "Fecha: 2026-08-21T10:02:00-05:00", "Asunto: RE: Solicitud de orden de compra SOL-001"])
      expect(txt).toContain(encabezado)
    expect(txt).toContain("Aprobado, proceder con la orden de compra.")
    const [contenido, lineaHash] = txt.split("\nsha256 del contenido anterior: ")
    expect(lineaHash!.trim()).toBe(sha256(contenido!))
    expect(r.data.sha256).toBe(sha256(contenido!))
  })

  test("P1: aprobacion.pdf válido, con el mismo hash y reproducible", async () => {
    const a = readFileSync(path.join(ctx.directory, "out/sol-001/aprobacion.pdf"))
    expect(a.subarray(0, 5).toString()).toBe("%PDF-")
    await llamar("oc_generar_evidencia", { caso: "sol-001" })
    const b = readFileSync(path.join(ctx.directory, "out/sol-001/aprobacion.pdf"))
    expect(Buffer.compare(a, b)).toBe(0) // fechas del PDF fijadas a la aprobación
  })

  test("el sha256 de la OC es el de la evidencia", async () => {
    const p = await llamar("oc_construir_payload", { caso: "sol-001" })
    const e = await llamar("oc_generar_evidencia", { caso: "sol-001" })
    expect(p.data.orden.aprobador.evidencia_sha256).toBe(e.data.sha256)
  })
})

describe("HU-3 · trazabilidad solo con las fuentes del PRD", () => {
  test("cada valor tiene fuente solicitud, cotizacion, maestro.<nombre> o derivado", async () => {
    await llamar("oc_construir_payload", { caso: "sol-006" })
    const traz = JSON.parse(readFileSync(path.join(ctx.directory, "out/sol-006/trazabilidad.json"), "utf-8")) as Record<string, { fuente: string }>
    const fuentes = new Set(Object.values(traz).map((t) => t.fuente))
    for (const f of fuentes) expect(f).toMatch(/^(solicitud|cotizacion|derivado|maestro\.[a-z-]+)$/)
    expect(traz["condiciones_pago"]).toMatchObject({ fuente: "maestro.proveedores" })
  })
})

describe("HU-5 · oc_crear idempotente devuelve { numero_oc, fecha, idempotente }", () => {
  test("la segunda llamada informa la fecha original", async () => {
    const p = await llamar("oc_construir_payload", { caso: "sol-001" })
    const primera = await llamar("oc_crear", { caso: "sol-001", payload: p.data.orden })
    const segunda = await llamar("oc_crear", { caso: "sol-001", payload: p.data.orden })
    expect(segunda.data).toMatchObject({ numero_oc: primera.data.numero_oc, fecha: primera.data.fecha, idempotente: true, retroactiva: false })
    expect(segunda.data.nota).toContain("creación original")
  })
})

describe("oc_leer_excel { ruta } → { filas[] }", () => {
  test("lee las filas y valida cada una como solicitud", async () => {
    const r = await llamar("oc_leer_excel", { ruta: "ejemplos/solicitudes.xlsx" })
    expect(r.ok).toBe(true)
    expect(r.data.filas).toHaveLength(6)
    expect(r.data.filas[3]).toMatchObject({ solicitud_id: "SOL-2026-004", valor_total: 25_000_000, fecha_solicitud: "2026-08-26" })
    expect(r.data.solicitudes.every((s: { ok: boolean }) => s.ok)).toBe(true)
  })
  test.each([
    ["../PRD.md", "sale del proyecto"],
    ["C:/Windows/win.ini", "relativa"],
    ["/etc/passwd", "relativa"],
    ["fixtures/reto-03/maestros/proveedores.json", ".xlsx"],
    ["ejemplos/no-existe.xlsx", "No existe"],
  ])("rechaza %s", async (ruta, motivo) => {
    expect(await llamar("oc_leer_excel", { ruta })).toMatchObject({ ok: false, error: expect.stringContaining(motivo) })
  })
})

describe("oc_validar informa el conteo de controles ya calculado", () => {
  test.each([
    ["sol-001", "10 de 10"],
    ["sol-004", "9 de 10"],
  ])("%s → %s", async (caso, esperado) => {
    const r = await llamar("oc_validar", { caso })
    expect(r.data.controles_cumplen).toBe(esperado)
  })
})
