import { useCallback, useRef, useState } from "react"
import type { Evento } from "../../src/agent/ciclo.ts"

// Estado del chat y cliente SSE. Los tipos de evento se importan del backend: un solo contrato.

type Herramienta = Extract<Evento, { tipo: "herramienta_resultado" }>
export type Item =
  | { clave: string; tipo: "usuario"; texto: string }
  | { clave: string; tipo: "asistente"; texto: string }
  | { clave: string; tipo: "herramienta"; id: string; nombre: string; args: unknown; estado: "ejecutando" | "ok" | "error"; r?: Herramienta }
  | { clave: string; tipo: "confirmacion"; caso: string; confirmaciones: { codigo: string; detalle: string }[]; estado: "pendiente" | "aprobada" | "rechazada" }
  | { clave: string; tipo: "aviso"; nivel: "info" | "error"; texto: string }

let n = 0
const clave = () => `i${++n}`

/** Reductor puro: aplica un evento del backend a la lista visible. */
export function aplicar(items: Item[], e: Evento): Item[] {
  switch (e.tipo) {
    case "texto": {
      const u = items.at(-1)
      return u?.tipo === "asistente" ? [...items.slice(0, -1), { ...u, texto: u.texto + e.delta }] : [...items, { clave: clave(), tipo: "asistente", texto: e.delta }]
    }
    case "herramienta_inicio":
      return [...items, { clave: clave(), tipo: "herramienta", id: e.id, nombre: e.nombre, args: e.args, estado: "ejecutando" }]
    case "herramienta_resultado":
      return items.map((i) => (i.tipo === "herramienta" && i.id === e.id ? { ...i, estado: e.ok ? "ok" : "error", r: e } : i))
    case "confirmacion_requerida": {
      // Una sola tarjeta pendiente por caso: se reemplaza la anterior si el agente vuelve a pedirla.
      const sin = items.filter((i) => !(i.tipo === "confirmacion" && i.estado === "pendiente"))
      return [...sin, { clave: clave(), tipo: "confirmacion", caso: e.caso, confirmaciones: e.confirmaciones, estado: "pendiente" }]
    }
    case "aviso":
      return [...items, { clave: clave(), tipo: "aviso", nivel: e.nivel, texto: e.texto }]
    case "fin":
      return e.needsConfirmation ? items : items.map((i) => (i.tipo === "confirmacion" && i.estado === "pendiente" ? { ...i, estado: "aprobada" } : i))
    case "sesion":
      return items
  }
}

/** Separa los eventos completos de un búfer SSE; devuelve el resto incompleto. */
export function extraerEventos(bufer: string): { eventos: Evento[]; resto: string } {
  const bloques = bufer.replace(/\r\n/g, "\n").split("\n\n")
  const resto = bloques.pop() ?? ""
  const eventos = bloques.flatMap((b) => {
    const datos = b
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n")
    return datos ? [JSON.parse(datos) as Evento] : []
  })
  return { eventos, resto }
}

export function useChat() {
  const [items, setItems] = useState<Item[]>([])
  const [ocupado, setOcupado] = useState(false)
  const sessionId = useRef<string | null>(null)

  const enviar = useCallback(async (message: string, confirmar?: boolean) => {
    setItems((a) => [...a, { clave: clave(), tipo: "usuario", texto: message }])
    if (confirmar !== undefined)
      setItems((a) => a.map((i) => (i.tipo === "confirmacion" && i.estado === "pendiente" ? { ...i, estado: confirmar ? "aprobada" : "rechazada" } : i)))
    setOcupado(true)
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ message, ...(sessionId.current ? { sessionId: sessionId.current } : {}), ...(confirmar === undefined ? {} : { confirmar }) }),
      })
      if (!r.ok || !r.body) {
        const d = (await r.json().catch(() => null)) as { error?: string } | null
        throw new Error(d?.error ?? `Error ${r.status}`)
      }
      const lector = r.body.pipeThrough(new TextDecoderStream()).getReader()
      let bufer = ""
      for (;;) {
        const { value, done } = await lector.read()
        if (done) break
        const { eventos, resto } = extraerEventos(bufer + value)
        bufer = resto
        for (const e of eventos) {
          if (e.tipo === "sesion") sessionId.current = e.sessionId
          setItems((a) => aplicar(a, e))
        }
      }
    } catch (e) {
      setItems((a) => [...a, { clave: clave(), tipo: "aviso", nivel: "error", texto: (e as Error).message }])
    } finally {
      setOcupado(false)
    }
  }, [])

  const reiniciar = useCallback(() => {
    sessionId.current = null
    setItems([])
  }, [])

  const pendiente = items.find((i): i is Extract<Item, { tipo: "confirmacion" }> => i.tipo === "confirmacion" && i.estado === "pendiente") ?? null
  return { items, ocupado, pendiente, enviar, reiniciar }
}
