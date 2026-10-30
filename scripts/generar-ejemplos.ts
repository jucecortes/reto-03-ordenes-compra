// Genera ejemplos/solicitudes.xlsx a partir de los solicitud.json de los fixtures: es el formato
// "solicitud.xlsx" del proceso real (PRD §2.1) para probar oc_leer_excel.
// Uso: bun run scripts/generar-ejemplos.ts
import { mkdirSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import ExcelJS from "exceljs"

const raiz = path.resolve(import.meta.dir, "..")
const dir = path.join(raiz, "fixtures", "reto-03", "solicitudes")
const columnas = [
  "solicitud_id",
  "solicitante",
  "proveedor_nombre",
  "proveedor_nit",
  "descripcion",
  "centro_costo",
  "subarea",
  "cantidad",
  "valor_unitario",
  "valor_total",
  "moneda",
  "indicador_iva",
  "condiciones_pago",
  "fecha_solicitud",
]

const libro = new ExcelJS.Workbook()
libro.creator = "reto-03-ordenes-compra"
libro.created = new Date("2026-08-29T00:00:00Z")
libro.modified = libro.created
const hoja = libro.addWorksheet("Solicitudes")
hoja.addRow(columnas)
for (const caso of readdirSync(dir).filter((c) => /^sol-\d{3}$/.test(c)).sort()) {
  const s = JSON.parse(readFileSync(path.join(dir, caso, "solicitud.json"), "utf-8")) as Record<string, unknown>
  hoja.addRow(columnas.map((c) => s[c] ?? null))
}
hoja.getRow(1).font = { bold: true }

mkdirSync(path.join(raiz, "ejemplos"), { recursive: true })
await libro.xlsx.writeFile(path.join(raiz, "ejemplos", "solicitudes.xlsx"))
console.log(`✔ ejemplos/solicitudes.xlsx (${hoja.rowCount - 1} solicitudes)`)
