import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { DefinicionHerramienta, Mensaje, ProveedorLlm } from "../llm/adapter.ts"
import { ejecutarHerramienta, herramientas } from "../tools/oc.ts"

// Ciclo del agente (PRD §6.3): prompt → modelo → herramientas → respuesta, con tope de iteraciones
// (CA1), confirmación humana controlada por el backend (CA3), historial visible (CA4) y errores
// que no matan la sesión (CA5).

export type Evento =
  | { tipo: "sesion"; sessionId: string }
  | { tipo: "texto"; delta: string }
  | { tipo: "herramienta_inicio"; id: string; nombre: string; args: unknown }
  | {
      tipo: "herramienta_resultado"
      id: string
      nombre: string
      ok: boolean
      resumen: string
      resultado: unknown
      ms: number
      /** El modelo pidió confirmado=true sin confirmación del usuario y el backend lo anuló. */
      confirmacionAnulada?: boolean
    }
  | { tipo: "confirmacion_requerida"; caso: string; confirmaciones: { codigo: string; detalle: string }[] }
  | { tipo: "aviso"; nivel: "info" | "error"; texto: string }
  | { tipo: "fin"; needsConfirmation: boolean; uso: { entrada: number; salida: number } }

export type Emisor = (e: Evento) => void

type Pendiente = { caso: string; confirmaciones: { codigo: string; detalle: string }[] }

export type Sesion = {
  id: string
  mensajes: Mensaje[]
  /** Historial visible: lo que devuelve GET /api/sessions/:id y lo que pinta el front. */
  historial: (Evento | { tipo: "usuario"; texto: string; confirmar?: boolean })[]
  pendiente: Pendiente | null
  tokens: number
  ocupada: boolean
  creada: string
}

export type ConfigAgente = {
  directory: string
  system: string
  maxIteraciones: number
  maxTokensSesion: number
}

// (?![\p{L}\d]) en lugar de \b: \b no trata "í" ni "é" como letras.
const AFIRMATIVO = /^\s*(s[ií]|confirmo|confirmado|de acuerdo|ok|adelante|procede|proceder|cr[eé]ala|cr[eé]alas|apruebo)(?![\p{L}\d])/iu
const NEGATIVO = /(?<![\p{L}\d])(no|rechazo|rechazar|cancela|cancelar|espera)(?![\p{L}\d])/iu

/** ¿El mensaje del usuario confirma? Botón explícito o texto afirmativo sin negación. */
export function esConfirmacion(texto: string, confirmar?: boolean): boolean {
  if (confirmar !== undefined) return confirmar
  return AFIRMATIVO.test(texto) && !NEGATIVO.test(texto)
}

export function definicionesHerramientas(): DefinicionHerramienta[] {
  return Object.entries(herramientas).map(([nombre, h]) => ({
    nombre: `oc_${nombre}`,
    descripcion: h.description,
    esquema: z.toJSONSchema(z.object(h.args)) as Record<string, unknown>,
  }))
}

export class Agente {
  private readonly sesiones = new Map<string, Sesion>()
  private readonly definiciones = definicionesHerramientas()

  constructor(
    private readonly llm: ProveedorLlm,
    private readonly config: ConfigAgente,
  ) {}

  sesion(id?: string): Sesion {
    const existente = id ? this.sesiones.get(id) : undefined
    if (existente) return existente
    const nueva: Sesion = { id: id ?? randomUUID(), mensajes: [], historial: [], pendiente: null, tokens: 0, ocupada: false, creada: new Date().toISOString() }
    this.sesiones.set(nueva.id, nueva)
    return nueva
  }

  obtener(id: string): Sesion | undefined {
    return this.sesiones.get(id)
  }

  /** Un turno completo del usuario. Nunca lanza: los errores llegan como evento "aviso". */
  async turno(sesion: Sesion, texto: string, emitirExterno: Emisor, confirmar?: boolean): Promise<void> {
    const emitir: Emisor = (e) => {
      if (e.tipo !== "texto") sesion.historial.push(e)
      else {
        const ultimo = sesion.historial.at(-1)
        if (ultimo?.tipo === "texto") ultimo.delta += e.delta
        else sesion.historial.push({ ...e })
      }
      emitirExterno(e)
    }
    if (sesion.ocupada) {
      emitirExterno({ tipo: "aviso", nivel: "error", texto: "La sesión está procesando otro mensaje; espera la respuesta." })
      return
    }
    sesion.ocupada = true
    const uso = { entrada: 0, salida: 0 }
    try {
      // CA3: la autorización vale solo para este turno y solo para el caso pendiente.
      const autorizado = sesion.pendiente && esConfirmacion(texto, confirmar) ? sesion.pendiente.caso : null
      sesion.historial.push({ tipo: "usuario", texto, ...(confirmar !== undefined ? { confirmar } : {}) })
      sesion.mensajes.push({
        rol: "usuario",
        texto: autorizado
          ? `${texto}\n\n[Sistema: la analista confirmó explícitamente las excepciones de ${autorizado} en este mensaje.]`
          : confirmar === false
            ? `${texto}\n\n[Sistema: la analista rechazó crear la OC pendiente.]`
            : texto,
      })
      if (confirmar === false) sesion.pendiente = null

      for (let i = 0; ; i++) {
        if (sesion.tokens >= this.config.maxTokensSesion) {
          emitir({ tipo: "aviso", nivel: "error", texto: `La sesión alcanzó el tope de ${this.config.maxTokensSesion} tokens. Inicia una nueva conversación.` })
          break
        }
        const alcanzoTope = i >= this.config.maxIteraciones
        if (alcanzoTope) {
          // CA1: sin más herramientas; el modelo responde con lo que tiene y lo que falta.
          sesion.mensajes.push({ rol: "usuario", texto: "[Sistema: se alcanzó el tope de iteraciones de este turno. Responde con lo que tienes y lo que falta, sin llamar herramientas.]" })
        }
        let huboStreaming = false
        const r = await this.llm.enviar(sesion.mensajes, alcanzoTope ? [] : this.definiciones, {
          system: this.config.system,
          alTexto: (delta) => {
            huboStreaming = true
            emitir({ tipo: "texto", delta })
          },
        })
        // Proveedor sin streaming: el texto llega completo al final.
        if (!huboStreaming && r.texto) emitir({ tipo: "texto", delta: r.texto })
        uso.entrada += r.uso.entrada
        uso.salida += r.uso.salida
        sesion.tokens += r.uso.entrada + r.uso.salida
        sesion.mensajes.push({ rol: "asistente", texto: r.texto, llamadas: r.llamadas, nativo: r.nativo })

        if (r.motivo === "rechazo") {
          emitir({ tipo: "aviso", nivel: "info", texto: "El modelo declinó responder esta solicitud." })
          break
        }
        if (r.motivo === "limite" && r.llamadas.length > 0) {
          emitir({ tipo: "aviso", nivel: "error", texto: "La respuesta del modelo se cortó antes de completar una herramienta. Intenta de nuevo." })
          break
        }
        if (r.llamadas.length === 0 || alcanzoTope) break

        const resultados = []
        for (const llamada of r.llamadas) resultados.push(await this.ejecutar(sesion, llamada, autorizado, emitir))
        sesion.mensajes.push({ rol: "herramienta", resultados })
      }
    } catch (e) {
      // CA5: error del proveedor LLM (timeout, red, límite) en lenguaje claro; la sesión sigue viva.
      emitir({ tipo: "aviso", nivel: "error", texto: `No pude completar la respuesta: ${mensajeError(e)}. Puedes reintentar.` })
      reparar(sesion)
    } finally {
      sesion.ocupada = false
      if (sesion.pendiente) emitir({ tipo: "confirmacion_requerida", caso: sesion.pendiente.caso, confirmaciones: sesion.pendiente.confirmaciones })
      emitir({ tipo: "fin", needsConfirmation: sesion.pendiente !== null, uso })
    }
  }

  private async ejecutar(sesion: Sesion, llamada: { id: string; nombre: string; args: unknown }, autorizado: string | null, emitir: Emisor) {
    emitir({ tipo: "herramienta_inicio", id: llamada.id, nombre: llamada.nombre, args: llamada.args })
    const inicio = Date.now()
    let args = llamada.args
    let confirmacionAnulada = false

    // CA3 en el backend: confirmado=true solo pasa si el usuario confirmó este caso en este turno.
    if (llamada.nombre === "oc_crear" && esObjeto(args) && args.confirmado === true && args.caso !== autorizado) {
      args = { ...args, confirmado: false }
      confirmacionAnulada = true
    }
    const contenido = await ejecutarHerramienta(llamada.nombre, args, {
      directory: this.config.directory,
      sessionId: sesion.id,
      ...(autorizado ? { confirmadoPor: `analista (sesión ${sesion.id.slice(0, 8)})` } : {}),
    })
    const r = JSON.parse(contenido) as { ok: boolean; data?: Record<string, unknown>; error?: string }
    this.actualizarPendiente(sesion, llamada.nombre, args, r)

    emitir({
      tipo: "herramienta_resultado",
      id: llamada.id,
      nombre: llamada.nombre,
      ok: r.ok,
      resumen: resumir(llamada.nombre, r),
      resultado: r.ok ? r.data : { error: r.error },
      ms: Date.now() - inicio,
      ...(confirmacionAnulada ? { confirmacionAnulada } : {}),
    })
    return { id: llamada.id, nombre: llamada.nombre, contenido, error: !r.ok }
  }

  /** Lleva el estado de la confirmación pendiente a partir de lo que devuelven las herramientas. */
  private actualizarPendiente(sesion: Sesion, nombre: string, args: unknown, r: { ok: boolean; data?: Record<string, unknown>; error?: string }) {
    const caso = esObjeto(args) && typeof args.caso === "string" ? args.caso : null
    if (!caso) return
    if (nombre === "oc_validar" && r.ok && r.data) {
      const confirmaciones = (r.data.confirmaciones as { regla: string; codigo: string; detalle: string }[]) ?? []
      sesion.pendiente =
        r.data.apta === true && confirmaciones.length > 0
          ? { caso, confirmaciones: confirmaciones.map((c) => ({ codigo: `${c.regla}:${c.codigo}`, detalle: c.detalle })) }
          : sesion.pendiente?.caso === caso
            ? null
            : sesion.pendiente
    }
    if (nombre === "oc_crear" && r.ok && sesion.pendiente?.caso === caso) sesion.pendiente = null
  }
}

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

function resumir(nombre: string, r: { ok: boolean; data?: Record<string, unknown>; error?: string }): string {
  if (!r.ok) return r.error?.split(":")[0] ?? "error"
  const d = r.data ?? {}
  switch (nombre) {
    case "oc_leer_paquete": {
      const faltantes = (d.faltantes as unknown[] | undefined)?.length ?? 0
      return `paquete leído${d.factura ? " · con factura" : ""}${faltantes ? ` · ${faltantes} adjunto(s) faltante(s)` : ""}`
    }
    case "oc_validar":
      return `apta=${d.apta} · ${(d.bloqueos as unknown[]).length} bloqueo(s) · ${(d.confirmaciones as unknown[]).length} confirmación(es)${d.retroactiva ? " · retroactiva" : ""}`
    case "oc_construir_payload":
      return `payload válido · trazabilidad en ${d.trazabilidad}`
    case "oc_generar_evidencia":
      return `evidencia ${d.ruta} + ${d.ruta_pdf}`
    case "oc_leer_excel": {
      const solicitudes = d.solicitudes as { ok: boolean }[] | null
      const filas = (d.filas as unknown[]).length
      return `${filas} fila(s)${solicitudes ? ` · ${solicitudes.filter((x) => x.ok).length} solicitud(es) válida(s)` : ""}`
    }
    case "oc_crear":
      return `OC ${d.numero_oc}${d.idempotente ? " (ya existía)" : ""}${d.retroactiva ? " · retroactiva" : ""}`
    default:
      return "ok"
  }
}

function mensajeError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  if (/timeout|timed out/i.test(m)) return "el modelo tardó demasiado en responder"
  if (/401|authentication|api key/i.test(m)) return "la clave del proveedor no es válida"
  if (/429|rate/i.test(m)) return "el proveedor está limitando las peticiones"
  return m.length > 200 ? `${m.slice(0, 200)}…` : m
}

/** Tras un error a mitad de turno, el historial puede quedar con llamadas sin resultado: se recorta. */
function reparar(sesion: Sesion) {
  const ultimo = sesion.mensajes.at(-1)
  if (ultimo?.rol === "asistente" && ultimo.llamadas.length > 0) sesion.mensajes.pop()
}
