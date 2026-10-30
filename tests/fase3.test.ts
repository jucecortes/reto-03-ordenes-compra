import { beforeEach, describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Agente, esConfirmacion, type Evento } from "../src/agent/ciclo.ts"
import type { Mensaje, ProveedorLlm, RespuestaLlm } from "../src/llm/adapter.ts"
import { crearApp } from "../src/server.ts"
import { reiniciarEstado } from "../src/tools/oc.ts"

// Modelo guionado: cada paso es una función de la conversación, así puede reenviar el payload
// que devolvió oc_construir_payload como lo haría el modelo real.

type Paso = (m: Mensaje[]) => Partial<RespuestaLlm> | Error
let n = 0
const id = () => `t${++n}`
const llamar = (nombre: string, args: unknown): Partial<RespuestaLlm> => ({ llamadas: [{ id: id(), nombre, args }] })
const decir = (texto: string): Partial<RespuestaLlm> => ({ texto })

function ultimoResultado(m: Mensaje[], nombre: string): { ok: boolean; data?: Record<string, unknown>; error?: string } {
  for (const msg of [...m].reverse()) {
    if (msg.rol !== "herramienta") continue
    const r = msg.resultados.find((x) => x.nombre === nombre)
    if (r) return JSON.parse(r.contenido)
  }
  throw new Error(`no hay resultado de ${nombre}`)
}
const payload = (m: Mensaje[]) => ultimoResultado(m, "oc_construir_payload").data?.orden

class ModeloGuionado implements ProveedorLlm {
  readonly proveedor = "guion"
  readonly modelo = "guion-1"
  readonly herramientasPorLlamada: number[] = []
  constructor(private readonly pasos: Paso[]) {}
  async enviar(mensajes: Mensaje[], herramientas: unknown[]): Promise<RespuestaLlm> {
    this.herramientasPorLlamada.push(herramientas.length)
    const paso = this.pasos.shift()
    if (!paso) return { texto: "fin del guion", llamadas: [], motivo: "fin", uso: { entrada: 10, salida: 5 } }
    const r = paso(mensajes)
    if (r instanceof Error) throw r
    const llamadas = r.llamadas ?? []
    return { texto: r.texto ?? "", llamadas, motivo: llamadas.length ? "herramientas" : "fin", uso: { entrada: 100, salida: 20 } }
  }
}

let directory: string
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "reto03-agente-"))
  cpSync(path.resolve(import.meta.dir, "../fixtures"), path.join(directory, "fixtures"), { recursive: true })
  reiniciarEstado()
})

function montar(pasos: Paso[], maxIteraciones = 25, maxTokensSesion = 1_000_000) {
  const modelo = new ModeloGuionado(pasos)
  const agente = new Agente(modelo, { directory, system: "prueba", maxIteraciones, maxTokensSesion })
  const sesion = agente.sesion()
  const eventos: Evento[] = []
  const turno = (texto: string, confirmar?: boolean) => agente.turno(sesion, texto, (e) => eventos.push(e), confirmar)
  return { modelo, agente, sesion, eventos, turno }
}
const resultados = (eventos: Evento[], nombre: string) =>
  eventos.filter((e): e is Extract<Evento, { tipo: "herramienta_resultado" }> => e.tipo === "herramienta_resultado" && e.nombre === nombre)
const fin = (eventos: Evento[]) => eventos.findLast((e): e is Extract<Evento, { tipo: "fin" }> => e.tipo === "fin")!

describe("esConfirmacion", () => {
  test.each([
    ["confirmo", true],
    ["Sí, créala", true],
    ["ok, adelante", true],
    ["no confirmo", false],
    ["¿qué significa RC5?", false],
    ["sí pero espera", false],
  ])("%s → %p", (t, esperado) => expect(esConfirmacion(t)).toBe(esperado))
  test("el botón manda sobre el texto", () => expect(esConfirmacion("lo que sea", true)).toBe(true))
})

describe("ciclo del agente", () => {
  test("sol-001: flujo normal crea la OC sin intervención (O1)", async () => {
    const { eventos, turno } = montar([
      () => llamar("oc_validar", { caso: "sol-001" }),
      () => llamar("oc_construir_payload", { caso: "sol-001" }),
      () => llamar("oc_generar_evidencia", { caso: "sol-001" }),
      (m) => llamar("oc_crear", { caso: "sol-001", payload: payload(m) }),
      () => decir("OC creada."),
    ])
    await turno("procesa sol-001")
    expect(resultados(eventos, "oc_crear")[0]).toMatchObject({ ok: true, resumen: "OC 4500000001" })
    expect(fin(eventos).needsConfirmation).toBe(false)
  })

  test("sol-004: pide confirmación; el backend anula confirmado=true sin el sí del usuario; tras 'confirmo' crea", async () => {
    const { eventos, turno, sesion } = montar([
      () => llamar("oc_validar", { caso: "sol-004" }),
      () => llamar("oc_construir_payload", { caso: "sol-004" }),
      (m) => llamar("oc_crear", { caso: "sol-004", payload: payload(m), confirmado: true }), // el modelo se adelanta
      () => decir("¿Confirmas la diferencia de 6 %?"),
      (m) => llamar("oc_crear", { caso: "sol-004", payload: payload(m), confirmado: true }),
      () => decir("Listo."),
    ])
    await turno("procesa sol-004")
    const primero = resultados(eventos, "oc_crear")[0]!
    expect(primero).toMatchObject({ ok: false, confirmacionAnulada: true })
    expect(fin(eventos).needsConfirmation).toBe(true)
    expect(sesion.pendiente?.caso).toBe("sol-004")
    expect(eventos.some((e) => e.tipo === "confirmacion_requerida")).toBe(true)

    await turno("confirmo")
    const segundo = resultados(eventos, "oc_crear")[1]!
    expect(segundo).toMatchObject({ ok: true, resumen: "OC 4500000001" })
    expect(segundo.confirmacionAnulada).toBeUndefined()
    expect(fin(eventos).needsConfirmation).toBe(false)
    const control = readFileSync(path.join(directory, "out/control.csv"), "utf-8")
    expect(control).toContain("SOL-2026-004,pendiente_confirmacion")
    expect(control).toContain("SOL-2026-004,creada,4500000001")
  })

  test("una pregunta no es confirmación; el botón Rechazar limpia el pendiente", async () => {
    const { eventos, turno, sesion } = montar([
      () => llamar("oc_validar", { caso: "sol-005" }),
      () => decir("¿Confirmas?"),
      (m) => llamar("oc_crear", { caso: "sol-005", payload: {}, confirmado: true }),
      () => decir("Necesito tu confirmación."),
      () => decir("Entendido, no la creo."),
    ])
    await turno("procesa sol-005")
    await turno("¿por qué es retroactiva?")
    expect(resultados(eventos, "oc_crear")[0]).toMatchObject({ ok: false, confirmacionAnulada: true })
    await turno("Rechazar", false)
    expect(sesion.pendiente).toBeNull()
    expect(fin(eventos).needsConfirmation).toBe(false)
  })

  test("CA1: al alcanzar el tope responde sin herramientas", async () => {
    const siempre = () => llamar("oc_leer_paquete", { caso: "sol-001" })
    const { modelo, eventos, turno } = montar([siempre, siempre, siempre, () => decir("Tengo el paquete; falta validar.")], 3)
    await turno("procesa sol-001")
    expect(modelo.herramientasPorLlamada).toEqual([5, 5, 5, 0])
    expect(resultados(eventos, "oc_leer_paquete")).toHaveLength(3)
  })

  test("CA5: un error del proveedor se muestra y la sesión sigue viva", async () => {
    const { eventos, turno } = montar([() => new Error("Request timed out"), () => decir("Hola de nuevo")])
    await turno("hola")
    expect(eventos.find((e) => e.tipo === "aviso")).toMatchObject({ nivel: "error", texto: expect.stringContaining("tardó demasiado") })
    await turno("¿sigues ahí?")
    expect(eventos.filter((e) => e.tipo === "texto").map((e) => (e as { delta: string }).delta)).toContain("Hola de nuevo")
  })

  test("tope de tokens por sesión", async () => {
    const { eventos, turno } = montar([() => decir("uno"), () => decir("dos")], 25, 100)
    await turno("a")
    await turno("b")
    expect(eventos.findLast((e) => e.tipo === "aviso")).toMatchObject({ texto: expect.stringContaining("tope") })
  })
})

describe("API HTTP (PRD §6.4)", () => {
  test("/api/health no expone la clave", async () => {
    const app = crearApp({ llm: new ModeloGuionado([]), directory })
    const r = await (await app.request("/api/health")).json()
    expect(r).toEqual({ ok: true, provider: "guion", model: "guion-1", llmConfigurado: true })
  })

  test("/api/chat en JSON y /api/sessions/:id con el historial", async () => {
    const app = crearApp({
      llm: new ModeloGuionado([() => llamar("oc_validar", { caso: "sol-006" }), () => decir("¿Confirmas el IVA C1 derivado?")]),
      directory,
    })
    const res = await app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "procesa sol-006" }) })
    const r = await res.json()
    expect(r).toMatchObject({ reply: "¿Confirmas el IVA C1 derivado?", needsConfirmation: true, confirmacion: { caso: "sol-006" } })
    expect(r.toolCalls[0]).toMatchObject({ nombre: "oc_validar", ok: true })
    const s = await (await app.request(`/api/sessions/${r.sessionId}`)).json()
    expect(s.historial[0]).toEqual({ tipo: "usuario", texto: "procesa sol-006" })
    expect(s.pendiente.caso).toBe("sol-006")
  })

  test("/api/chat con streaming SSE", async () => {
    const app = crearApp({ llm: new ModeloGuionado([() => decir("hola")]), directory })
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ message: "hola" }),
    })
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const cuerpo = await res.text()
    expect(cuerpo).toContain("event: texto")
    expect(cuerpo).toContain("event: fin")
  })

  test("503 sin modelo, 400 con cuerpo inválido, 429 al superar el límite", async () => {
    expect((await crearApp({ llm: null, directory }).request("/api/chat", { method: "POST", body: "{}" })).status).toBe(503)
    const app = crearApp({ llm: new ModeloGuionado([]), directory, limite: 1 })
    const pedir = () => app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "" }) })
    expect((await pedir()).status).toBe(400)
    expect((await pedir()).status).toBe(429)
  })
})
