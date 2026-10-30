// Fase 1 · DoD: carga los maestros y los 6 casos validando cada archivo con zod.
// Uso: bun run scripts/cargar.ts  (exit 1 si algo no valida)
import { readdirSync } from "node:fs"
import path from "node:path"
import { CASO_VALIDO, leerMaestros, leerPaquete } from "../src/fixtures/lector.ts"
import { formatoCop } from "../src/schemas/valores.ts"

const raiz = path.resolve(import.meta.dir, "..")
let errores = 0

const maestros = await leerMaestros(raiz)
if (!maestros.ok) {
  console.error("✘ maestros:", maestros.error)
  process.exit(1)
}
const m = maestros.data
console.log(
  `✔ maestros: ${m.proveedores.length} proveedores, ${m.centrosCosto.length} centros de costo, ` +
    `${m.indicadoresIva.length} indicadores de IVA, ${m.condicionesPago.length} condiciones de pago`,
)

const casos = readdirSync(path.join(raiz, "fixtures", "reto-03", "solicitudes")).filter((c) => CASO_VALIDO.test(c)).sort()
for (const caso of casos) {
  const r = await leerPaquete(raiz, caso)
  if (!r.ok) {
    errores++
    console.error(`✘ ${caso}: ${r.error}`)
    continue
  }
  const p = r.data
  const s = p.solicitud
  const partes = [
    `solicitud ${s.solicitud_id} ${formatoCop(s.valor_total)}`,
    p.cotizacion ? `cotización ${p.cotizacion.referencia} ${formatoCop(p.cotizacion.total)} NIT ${p.cotizacion.nit}` : "sin cotización",
    p.aprobacion ? `aprobación ${p.aprobacion.de} aprobado=${p.aprobacion.aprobado}` : "sin aprobación",
    p.factura ? `factura ${p.factura.numero} ${p.factura.fecha}` : "sin factura",
  ]
  if (p.faltantes.length) {
    errores++
    partes.push(`FALTANTES: ${p.faltantes.map((f) => `${f.adjunto} (${f.motivo})`).join(", ")}`)
  }
  console.log(`${p.faltantes.length ? "✘" : "✔"} ${caso}: ${partes.join(" · ")}`)
}

console.log(errores === 0 ? `\nOK: maestros y ${casos.length} casos cargados sin errores de validación` : `\n${errores} caso(s) con errores`)
process.exit(errores === 0 ? 0 : 1)
