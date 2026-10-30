import { createHash } from "node:crypto"
import { PDFDocument, StandardFonts } from "pdf-lib"
import type { Paquete } from "../schemas/paquete.ts"

// Evidencia de aprobación (HU-4).
// P0: out/<caso>/aprobacion.txt con encabezados (de, para, fecha, asunto), cuerpo y el sha256 del contenido.
// P1: out/<caso>/aprobacion.pdf con el mismo contenido.
// El hash se calcula sobre el contenido (encabezados + cuerpo) y es el mismo que va en
// aprobador.evidencia_sha256 del payload: la OC queda enlazada a su evidencia.

export const sha256 = (texto: string) => createHash("sha256").update(texto, "utf8").digest("hex")

/** Contenido de la evidencia: encabezados y cuerpo del correo de aprobación. Es lo que se firma con sha256. */
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

/** Archivo .txt: contenido + línea con su sha256 (HU-4 P0). */
export function archivoEvidenciaTxt(contenido: string): string {
  return `${contenido}\nsha256 del contenido anterior: ${sha256(contenido)}\n`
}

/**
 * Archivo .pdf con el mismo contenido y el mismo sha256 (HU-4 P1).
 * Las fechas del PDF se fijan a la fecha de la aprobación: el archivo es reproducible.
 */
export async function archivoEvidenciaPdf(contenido: string, fechaAprobacion: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const fuente = await pdf.embedFont(StandardFonts.Helvetica)
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold)
  const fecha = new Date(fechaAprobacion)
  pdf.setTitle("Evidencia de aprobación")
  pdf.setProducer("reto-03-ordenes-compra")
  pdf.setCreator("reto-03-ordenes-compra")
  pdf.setCreationDate(fecha)
  pdf.setModificationDate(fecha)

  const [ancho, alto] = [595.28, 841.89] // A4 en puntos
  const margen = 56
  const tamano = 11
  const interlineado = 15
  const lineas = [...contenido.split("\n"), "", `sha256 del contenido: ${sha256(contenido)}`]
  let pagina = pdf.addPage([ancho, alto])
  let y = alto - margen

  for (const [i, linea] of lineas.entries()) {
    const f = i === 0 ? negrita : fuente
    for (const tramo of partir(seguro(linea), f, tamano, ancho - 2 * margen)) {
      if (y < margen) {
        pagina = pdf.addPage([ancho, alto])
        y = alto - margen
      }
      pagina.drawText(tramo, { x: margen, y, size: i === lineas.length - 1 ? 8 : tamano, font: f })
      y -= interlineado
    }
  }
  return pdf.save()
}

/** Las fuentes estándar del PDF usan WinAnsi: se reemplazan caracteres que no puede dibujar. */
function seguro(texto: string): string {
  return texto.replace(/[^\x20-\x7E -ÿ·–—""''…€]/g, "?")
}

/** Ajuste de línea por ancho real del texto en la fuente. */
function partir(texto: string, fuente: { widthOfTextAtSize(t: string, s: number): number }, tamano: number, maximo: number): string[] {
  if (texto === "") return [""]
  const palabras = texto.split(" ")
  const tramos: string[] = []
  let actual = ""
  for (const p of palabras) {
    const candidato = actual ? `${actual} ${p}` : p
    if (fuente.widthOfTextAtSize(candidato, tamano) <= maximo) actual = candidato
    else {
      if (actual) tramos.push(actual)
      actual = p
    }
  }
  if (actual) tramos.push(actual)
  return tramos
}
