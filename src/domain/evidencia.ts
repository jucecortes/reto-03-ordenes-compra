import { createHash } from "node:crypto"
import type { Paquete } from "../schemas/paquete.ts"

// Evidencia de aprobación (HU-4 P0): el correo de aprobación como texto con encabezados y su sha256.
// La misma función alimenta oc_generar_evidencia y el campo aprobador.evidencia_sha256 del payload,
// así el hash de la OC siempre corresponde al archivo adjunto.

export function textoEvidencia(caso: string, aprobacion: NonNullable<Paquete["aprobacion"]>): string {
  return [
    `EVIDENCIA DE APROBACIÓN · ${caso}`,
    `De: ${aprobacion.de}`,
    `Para: ${aprobacion.para ?? "(no informado)"}`,
    `Fecha: ${aprobacion.fecha}`,
    `Asunto: ${aprobacion.asunto}`,
    "",
    aprobacion.texto.replace(/\r\n?/g, "\n").trim(),
    "",
  ].join("\n")
}

export const sha256 = (texto: string) => createHash("sha256").update(texto, "utf8").digest("hex")
