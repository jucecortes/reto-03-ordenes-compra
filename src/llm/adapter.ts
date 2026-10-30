// Adaptador de proveedor LLM (PRD §6.1): el ciclo del agente solo conoce esta interfaz.
// Cambiar de proveedor = otra implementación de ProveedorLlm; el ciclo no se toca.

export type LlamadaHerramienta = { id: string; nombre: string; args: unknown }
export type ResultadoHerramienta = { id: string; nombre: string; contenido: string; error: boolean }

/**
 * Mensajes en formato neutro. `nativo` guarda el contenido tal como lo devolvió el proveedor
 * (por ejemplo, bloques de razonamiento que la API exige reenviar sin cambios); solo lo lee
 * la implementación de ese proveedor.
 */
export type Mensaje =
  | { rol: "usuario"; texto: string }
  | { rol: "asistente"; texto: string; llamadas: LlamadaHerramienta[]; nativo?: unknown }
  | { rol: "herramienta"; resultados: ResultadoHerramienta[] }

export type DefinicionHerramienta = { nombre: string; descripcion: string; esquema: Record<string, unknown> }

export type RespuestaLlm = {
  texto: string
  llamadas: LlamadaHerramienta[]
  /** "herramientas": el modelo pidió herramientas; "fin": terminó; "limite": se cortó por tokens; "rechazo": declinó. */
  motivo: "fin" | "herramientas" | "limite" | "rechazo"
  uso: { entrada: number; salida: number }
  nativo?: unknown
}

export type OpcionesEnvio = {
  system: string
  /** Recibe el texto a medida que llega (streaming). */
  alTexto?: (fragmento: string) => void
  signal?: AbortSignal
}

export interface ProveedorLlm {
  readonly proveedor: string
  readonly modelo: string
  enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio): Promise<RespuestaLlm>
}
