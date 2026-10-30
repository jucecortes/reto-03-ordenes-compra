import { existsSync, readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Hono, type Context } from "hono"
import { serveStatic } from "hono/bun"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import { Agente, ARCHIVOS_EVIDENCIA, type Evento } from "./agent/ciclo.ts"
import type { ProveedorLlm } from "./llm/adapter.ts"
import { ProveedorAnthropic } from "./llm/anthropic.ts"
import { CASO_VALIDO, listarCasos } from "./fixtures/lector.ts"

// API HTTP del agente (PRD §6.4). La clave del modelo solo se lee aquí, de variables de entorno,
// y nunca se devuelve en respuestas ni se escribe en logs.

const raiz = path.resolve(import.meta.dir, "..")
const entero = (v: string | undefined, porDefecto: number) => (v && Number.isFinite(Number(v)) ? Number(v) : porDefecto)

export const config = {
  puerto: entero(process.env.PORT, 8787),
  modelo: process.env.LLM_MODEL ?? "claude-haiku-5-5",
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxIteraciones: entero(process.env.MAX_ITERACIONES, 25),
  maxTokensSesion: entero(process.env.MAX_TOKENS_SESION, 300_000),
  timeoutMs: entero(process.env.LLM_TIMEOUT_MS, 60_000),
  peticionesPorVentana: entero(process.env.RATE_LIMIT, 30),
  ventanaMs: 10 * 60 * 1000,
}

/** Comportamiento (agent/prompt.md) + conocimiento (src/knowledge/): ninguno está embebido en código. */
export function systemPrompt(): string {
  const prompt = readFileSync(path.join(raiz, "agent", "prompt.md"), "utf-8")
  const conocimiento = readFileSync(path.join(raiz, "src", "knowledge", "ordenes-compra.md"), "utf-8")
  return `${prompt}\n\n---\n\n${conocimiento}`
}

const chatSchema = z.object({
  sessionId: z.string().min(1).max(100).optional(),
  message: z.string().trim().min(1).max(4000),
  /** Botón Confirmar (true) o Rechazar (false) del front; si falta, se interpreta el texto. */
  confirmar: z.boolean().optional(),
})

class Limitador {
  private readonly marcas = new Map<string, number[]>()
  constructor(
    private readonly maximo: number,
    private readonly ventanaMs: number,
  ) {}
  permitir(ip: string, ahora = Date.now()): boolean {
    const recientes = (this.marcas.get(ip) ?? []).filter((t) => ahora - t < this.ventanaMs)
    const ok = recientes.length < this.maximo
    if (ok) recientes.push(ahora)
    this.marcas.set(ip, recientes)
    return ok
  }
}

export function crearApp(opciones: { llm?: ProveedorLlm | null; directory?: string; limite?: number } = {}) {
  const llm = opciones.llm !== undefined ? opciones.llm : config.apiKey ? new ProveedorAnthropic(config.modelo, config.apiKey, config.timeoutMs) : null
  const agente = llm
    ? new Agente(llm, { directory: opciones.directory ?? raiz, system: systemPrompt(), maxIteraciones: config.maxIteraciones, maxTokensSesion: config.maxTokensSesion })
    : null
  const limitador = new Limitador(opciones.limite ?? config.peticionesPorVentana, config.ventanaMs)
  const app = new Hono()

  app.get("/api/health", (c) => c.json({ ok: true, provider: llm?.proveedor ?? null, model: llm?.modelo ?? config.modelo, llmConfigurado: Boolean(llm) }))

  // Bandeja para el front: casos disponibles con su asunto (sin evaluar reglas ni llamar al modelo).
  app.get("/api/casos", async (c) => c.json(await listarCasos(opciones.directory ?? raiz)))

  app.get("/api/sessions/:id", (c) => {
    const s = agente?.obtener(c.req.param("id"))
    if (!s) return c.json({ ok: false, error: "Sesión no encontrada" }, 404)
    return c.json({ id: s.id, creada: s.creada, tokens: s.tokens, pendiente: s.pendiente, historial: s.historial })
  })

  // Descarga de la evidencia de aprobación. Acceso: solo la sesión que la generó (el id de sesión es un
  // UUID aleatorio que solo conoce ese navegador). Nombres de archivo en lista blanca: sin rutas arbitrarias.
  app.get("/api/sessions/:id/evidencias/:caso/:archivo", async (c) => {
    const s = agente?.obtener(c.req.param("id"))
    const { caso, archivo } = c.req.param()
    if (!s) return c.json({ ok: false, error: "Sesión no encontrada" }, 404)
    if (!CASO_VALIDO.test(caso) || !(ARCHIVOS_EVIDENCIA as readonly string[]).includes(archivo)) return c.json({ ok: false, error: "Evidencia no encontrada" }, 404)
    if (!s.evidencias.includes(caso)) return c.json({ ok: false, error: `Esta sesión no generó la evidencia de ${caso}; no tiene acceso a ella.` }, 403)
    const contenido = await readFile(path.join(opciones.directory ?? raiz, "out", caso, archivo)).catch(() => null)
    if (!contenido) return c.json({ ok: false, error: "La evidencia ya no está disponible; vuelve a generarla." }, 404)
    return c.body(new Uint8Array(contenido), 200, {
      "content-type": archivo.endsWith(".pdf") ? "application/pdf" : "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="${caso}-${archivo}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    })
  })

  app.post("/api/chat", async (c) => {
    if (!agente) return c.json({ ok: false, error: "El modelo no está configurado (falta ANTHROPIC_API_KEY en el servidor)." }, 503)
    if (!limitador.permitir(ipCliente(c))) return c.json({ ok: false, error: "Demasiadas peticiones; espera unos minutos." }, 429)
    const cuerpo = chatSchema.safeParse(await c.req.json().catch(() => null))
    if (!cuerpo.success) return c.json({ ok: false, error: z.prettifyError(cuerpo.error) }, 400)
    const { sessionId, message, confirmar } = cuerpo.data
    const sesion = agente.sesion(sessionId)

    // Streaming de eventos si el cliente lo pide (el front); JSON plano en otro caso (curl, pruebas).
    if (c.req.header("accept")?.includes("text/event-stream")) {
      return streamSSE(c, async (stream) => {
        const cola: Promise<void>[] = []
        const emitir = (e: Evento) => void cola.push(stream.writeSSE({ event: e.tipo, data: JSON.stringify(e) }))
        emitir({ tipo: "sesion", sessionId: sesion.id })
        await agente.turno(sesion, message, emitir, confirmar)
        await Promise.all(cola)
      })
    }

    const eventos: Evento[] = []
    await agente.turno(sesion, message, (e) => eventos.push(e), confirmar)
    const fin = eventos.findLast((e) => e.tipo === "fin")
    return c.json({
      sessionId: sesion.id,
      reply: eventos.flatMap((e) => (e.tipo === "texto" ? [e.delta] : [])).join(""),
      toolCalls: eventos.filter((e) => e.tipo === "herramienta_resultado"),
      needsConfirmation: fin?.tipo === "fin" ? fin.needsConfirmation : false,
      confirmacion: eventos.findLast((e) => e.tipo === "confirmacion_requerida") ?? null,
      avisos: eventos.filter((e) => e.tipo === "aviso"),
    })
  })

  // Front compilado (Fase 4): el mismo servicio sirve la API y el chat.
  const web = path.join(raiz, "web", "dist")
  if (existsSync(web)) {
    const relativo = path.relative(process.cwd(), web) || "."
    app.use("/*", serveStatic({ root: relativo }))
    app.get("*", serveStatic({ path: path.join(relativo, "index.html") }))
  }
  return app
}

function ipCliente(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "local"
}

if (import.meta.main) {
  const app = crearApp()
  Bun.serve({ port: config.puerto, fetch: app.fetch, idleTimeout: 120 })
  console.log(`API en http://localhost:${config.puerto} · modelo ${config.modelo} · LLM ${config.apiKey ? "configurado" : "NO configurado (falta ANTHROPIC_API_KEY)"}`)
}
