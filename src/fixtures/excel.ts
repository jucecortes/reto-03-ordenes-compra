import { stat } from "node:fs/promises"
import path from "node:path"
import ExcelJS from "exceljs"
import { z } from "zod"
import { solicitudSchema, type Solicitud } from "../schemas/documentos.ts"
import type { Resultado } from "./lector.ts"

// Lectura de Excel (PRD §6.2, oc_leer_excel). Restringida: solo .xlsx, dentro del proyecto,
// de tamaño acotado. Devuelve las filas de la primera hoja como objetos (encabezados = fila 1)
// y, si las columnas corresponden a una solicitud, la valida con el mismo esquema zod que solicitud.json.

export const TAMANO_MAXIMO_EXCEL = 5 * 1024 * 1024

export type Fila = Record<string, string | number | boolean | null>
export type LecturaExcel = {
  ruta: string
  hoja: string
  columnas: string[]
  filas: Fila[]
  /** Solo si la hoja tiene las columnas de una solicitud (PRD §7.1): validación zod fila por fila. */
  solicitudes: { fila: number; ok: boolean; solicitud?: Solicitud; error?: string }[] | null
}

/** Resuelve la ruta dentro del proyecto; rechaza rutas absolutas o que salgan de él. */
export function rutaSegura(directory: string, ruta: string): Resultado<string> {
  if (path.isAbsolute(ruta)) return { ok: false, error: "La ruta debe ser relativa al proyecto." }
  const absoluta = path.resolve(directory, ruta)
  const relativa = path.relative(directory, absoluta)
  if (relativa.startsWith("..") || path.isAbsolute(relativa)) return { ok: false, error: "La ruta sale del proyecto." }
  if (path.extname(absoluta).toLowerCase() !== ".xlsx") return { ok: false, error: "Solo se aceptan archivos .xlsx." }
  return { ok: true, data: absoluta }
}

function valorCelda(v: ExcelJS.CellValue): string | number | boolean | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v
  if (typeof v === "object") {
    if ("result" in v) return valorCelda(v.result as ExcelJS.CellValue) // fórmula: su resultado
    if ("richText" in v) return v.richText.map((t) => t.text).join("")
    if ("text" in v) return String(v.text) // hipervínculo
    if ("error" in v) return null
  }
  return String(v)
}

export async function leerExcel(directory: string, ruta: string): Promise<Resultado<LecturaExcel>> {
  const segura = rutaSegura(directory, ruta)
  if (!segura.ok) return segura
  const info = await stat(segura.data).catch(() => null)
  if (!info?.isFile()) return { ok: false, error: `No existe el archivo ${ruta}.` }
  if (info.size > TAMANO_MAXIMO_EXCEL) return { ok: false, error: `El archivo supera ${TAMANO_MAXIMO_EXCEL / 1024 / 1024} MB.` }

  const libro = new ExcelJS.Workbook()
  try {
    await libro.xlsx.readFile(segura.data)
  } catch {
    return { ok: false, error: `${ruta} no es un .xlsx válido.` }
  }
  const hoja = libro.worksheets[0]
  if (!hoja) return { ok: false, error: `${ruta} no tiene hojas.` }

  const columnas: string[] = []
  hoja.getRow(1).eachCell({ includeEmpty: false }, (celda, col) => {
    columnas[col - 1] = String(valorCelda(celda.value) ?? "").trim()
  })
  if (columnas.filter(Boolean).length === 0) return { ok: false, error: "La primera fila debe tener los encabezados." }

  const filas: Fila[] = []
  hoja.eachRow({ includeEmpty: false }, (fila, numero) => {
    if (numero === 1) return
    const objeto: Fila = {}
    columnas.forEach((nombre, i) => {
      if (nombre) objeto[nombre] = valorCelda(fila.getCell(i + 1).value)
    })
    filas.push(objeto)
  })

  // Si la hoja es una solicitud (PRD §7.1: solicitud.xlsx), se valida con el esquema de solicitud.json.
  const camposObligatorios = ["solicitud_id", "proveedor_nombre", "valor_total", "fecha_solicitud"]
  const esSolicitud = camposObligatorios.every((c) => columnas.includes(c))
  const solicitudes = esSolicitud
    ? filas.map((f, i) => {
        const limpia = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== null && v !== ""))
        const r = solicitudSchema.safeParse(limpia)
        return r.success ? { fila: i + 2, ok: true, solicitud: r.data } : { fila: i + 2, ok: false, error: z.prettifyError(r.error) }
      })
    : null

  return { ok: true, data: { ruta: path.relative(directory, segura.data).replaceAll("\\", "/"), hoja: hoja.name, columnas: columnas.filter(Boolean), filas, solicitudes } }
}
