import Anthropic from "@anthropic-ai/sdk"
import type { DefinicionHerramienta, Mensaje, OpcionesEnvio, ProveedorLlm, RespuestaLlm } from "./adapter.ts"

// Implementación del adaptador para Claude (API de Anthropic) con streaming.

type MensajeApi = Anthropic.Beta.Messages.BetaMessageParam
type BloqueApi = Anthropic.Beta.Messages.BetaContentBlock

export class ProveedorAnthropic implements ProveedorLlm {
  readonly proveedor = "anthropic"
  private readonly cliente: Anthropic

  constructor(
    readonly modelo: string,
    apiKey: string,
    timeoutMs: number,
  ) {
    this.cliente = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 })
  }

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio): Promise<RespuestaLlm> {
    const stream = this.cliente.beta.messages.stream(
      {
        model: this.modelo,
        max_tokens: 16000,
        // System prompt y herramientas son estables: se cachean entre turnos y sesiones.
        cache_control: { type: "ephemeral" },
        system: opciones.system,
        tools: herramientas.map((h) => ({
          name: h.nombre,
          description: h.descripcion,
          input_schema: h.esquema as Anthropic.Beta.Messages.BetaTool["input_schema"],
        })),
        messages: aMensajesApi(mensajes),
      },
      { signal: opciones.signal },
    )
    if (opciones.alTexto) stream.on("text", opciones.alTexto)
    const final = await stream.finalMessage()

    const llamadas = final.content
      .filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, nombre: b.name, args: b.input }))
    const texto = final.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
    const motivo: RespuestaLlm["motivo"] =
      final.stop_reason === "refusal" ? "rechazo" : final.stop_reason === "max_tokens" ? "limite" : llamadas.length > 0 ? "herramientas" : "fin"
    return {
      texto,
      llamadas,
      motivo,
      uso: { entrada: final.usage.input_tokens + (final.usage.cache_read_input_tokens ?? 0), salida: final.usage.output_tokens },
      // El contenido completo (incluidos bloques de razonamiento) se reenvía sin cambios.
      nativo: final.content,
    }
  }
}

function aMensajesApi(mensajes: Mensaje[]): MensajeApi[] {
  return mensajes.map((m): MensajeApi => {
    if (m.rol === "usuario") return { role: "user", content: m.texto }
    if (m.rol === "asistente") {
      if (m.nativo) return { role: "assistant", content: m.nativo as BloqueApi[] }
      return {
        role: "assistant",
        content: [
          ...(m.texto ? [{ type: "text" as const, text: m.texto }] : []),
          ...m.llamadas.map((l) => ({ type: "tool_use" as const, id: l.id, name: l.nombre, input: l.args as Record<string, unknown> })),
        ],
      }
    }
    // Todos los resultados de un turno van en un solo mensaje de usuario (requisito de la API).
    return {
      role: "user",
      content: m.resultados.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.contenido, ...(r.error ? { is_error: true } : {}) })),
    }
  })
}
