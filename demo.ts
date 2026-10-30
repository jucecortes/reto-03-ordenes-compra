/**
 * demo.ts — Verificación sin modelo de lenguaje (PRD §6.6).
 *
 * Procesa los 6 casos llamando DIRECTAMENTE a las herramientas de src/tools/oc.ts (las mismas
 * que usa el agente) y compara cada resultado con el oráculo de spec/reglas.md. Muestra la
 * idempotencia (sol-001 dos veces) y la confirmación explícita (sol-004, sol-005, sol-006).
 *
 *   bun install && bun run demo.ts      → exit 1 si algún caso difiere de la spec
 */
import { readFileSync, readdirSync, rmSync } from "node:fs"
import path from "node:path"
import { ejecutarHerramienta, reiniciarEstado, type Contexto } from "./src/tools/oc.ts"

type Hallazgo = { regla: string; codigo: string; detalle: string }
type Validacion = { solicitud_id: string; apta: boolean; bloqueos: Hallazgo[]; confirmaciones: Hallazgo[]; derivados: Record<string, string>; retroactiva: boolean }
type Esperado = { apta: boolean; bloqueos: string[]; confirmaciones: string[]; derivados: Record<string, string>; retroactiva: boolean; crea_sin_confirmar: boolean }

const directory = import.meta.dir
const ctx: Contexto = { directory, sessionId: "demo", confirmadoPor: "demo.ts" }
const etiqueta = (h: Hallazgo) => `${h.regla}:${h.codigo}`

// Oráculo: bloque JSON entre <!-- oraculo:inicio --> y <!-- oraculo:fin --> en spec/reglas.md.
const spec = readFileSync(path.join(directory, "spec", "reglas.md"), "utf-8")
const bloque = spec.split("<!-- oraculo:inicio")[1]?.split("```json")[1]?.split("```")[0]
if (!bloque) throw new Error("spec/reglas.md no contiene el bloque del oráculo")
const oraculo = JSON.parse(bloque) as Record<string, Esperado>

type Creada = { numero_oc: string; idempotente: boolean; retroactiva: boolean }

async function llamar<T>(nombre: string, args: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  return JSON.parse(await ejecutarHerramienta(nombre, args, ctx))
}

const fallas: string[] = []
const verificar = (cond: boolean, mensaje: string) => {
  console.log(`  ${cond ? "✔" : "✘"} ${mensaje}`)
  if (!cond) fallas.push(mensaje)
}
const igual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const linea = (c = "─") => console.log(c.repeat(100))

/** leer → validar → (si apta) construir payload → crear. Devuelve el resultado de crear. */
async function procesar(caso: string, confirmado?: boolean) {
  const v = await llamar<Validacion>("validar", { caso })
  if (!v.ok) return { v, crear: null }
  // Un caso bloqueado también intenta crear: así el intento queda registrado en out/control.csv (HU-5).
  if (!v.data.apta) return { v, crear: await llamar<Creada>("crear", { caso, payload: {} }) }
  const p = await llamar<{ orden: unknown }>("construir_payload", { caso })
  if (!p.ok) return { v, crear: p }
  const crear = await llamar<Creada>("crear", {
    caso,
    payload: p.data.orden,
    ...(confirmado === undefined ? {} : { confirmado }),
  })
  return { v, crear }
}

// ---------------------------------------------------------------------------------------------
rmSync(path.join(directory, "out"), { recursive: true, force: true }) // determinismo: out/ limpio
reiniciarEstado()

linea("═")
console.log("DEMO · Agente de Órdenes de Compra SAP — herramientas sin modelo de lenguaje")
linea("═")

const casos = readdirSync(path.join(directory, "fixtures", "reto-03", "solicitudes")).filter((c) => /^sol-\d{3}$/.test(c)).sort()
const tabla: { caso: string; apta: string; bloqueos: string; confirmaciones: string; retroactiva: string; resultado: string }[] = []

console.log("\n1) Primera pasada: los 6 casos, sin confirmar\n")
for (const caso of casos) {
  const { v, crear } = await procesar(caso)
  if (!v.ok) {
    verificar(false, `${caso}: oc_validar falló: ${v.error}`)
    continue
  }
  const d = v.data
  const esperado = oraculo[caso]
  console.log(`${caso} · ${d.solicitud_id}`)
  for (const b of d.bloqueos) console.log(`    ⛔ ${etiqueta(b)} — ${b.detalle}`)
  for (const c of d.confirmaciones) console.log(`    ❓ ${etiqueta(c)} — ${c.detalle}`)
  for (const [k, val] of Object.entries(d.derivados)) console.log(`    ↳ derivado ${k} = ${val}`)
  const resultado = crear?.ok ? `OC ${crear.data.numero_oc}` : (crear?.error.split(":")[0] ?? "—")
  console.log(`    → ${resultado}`)
  if (!esperado) {
    verificar(false, `${caso}: no tiene resultado esperado en la spec`)
    continue
  }
  verificar(
    d.apta === esperado.apta &&
      igual(d.bloqueos.map(etiqueta), esperado.bloqueos) &&
      igual(d.confirmaciones.map(etiqueta), esperado.confirmaciones) &&
      igual(d.derivados, esperado.derivados) &&
      d.retroactiva === esperado.retroactiva,
    `${caso}: apta=${d.apta} bloqueos=[${d.bloqueos.map(etiqueta)}] confirmaciones=[${d.confirmaciones.map(etiqueta)}] retroactiva=${d.retroactiva} coincide con la spec`,
  )
  verificar(Boolean(crear?.ok) === esperado.crea_sin_confirmar, `${caso}: ${esperado.crea_sin_confirmar ? "crea la OC sin confirmación" : "no crea OC sin confirmación"}`)
  tabla.push({
    caso,
    apta: d.apta ? "sí" : "no",
    bloqueos: d.bloqueos.map(etiqueta).join(", ") || "—",
    confirmaciones: d.confirmaciones.map(etiqueta).join(", ") || "—",
    retroactiva: d.retroactiva ? "sí" : "no",
    resultado,
  })
}

console.log("\n2) Idempotencia: sol-001 por segunda vez\n")
const repetido = await procesar("sol-001")
const numeroPrimero = tabla.find((t) => t.caso === "sol-001")?.resultado
verificar(
  repetido.crear?.ok === true && repetido.crear.data.idempotente === true && `OC ${repetido.crear.data.numero_oc}` === numeroPrimero,
  `sol-001 devuelve la misma ${numeroPrimero} con idempotente=true (no crea una segunda OC)`,
)

console.log("\n3) Confirmación explícita del usuario (confirmado = true)\n")
for (const caso of casos.filter((c) => oraculo[c]?.apta && !oraculo[c]?.crea_sin_confirmar)) {
  const { crear } = await procesar(caso, true)
  const ok = crear?.ok === true
  console.log(`${caso}: usuario confirma → ${ok ? `OC ${crear.data.numero_oc}${crear.data.retroactiva ? " · retroactiva = true" : ""}` : crear?.error}`)
  verificar(ok, `${caso}: con confirmado=true se crea la OC`)
  const fila = tabla.find((t) => t.caso === caso)
  if (fila && ok) fila.resultado = `OC ${crear.data.numero_oc} (confirmada)`
}

console.log("\n4) Resumen\n")
console.table(tabla)

const control = readFileSync(path.join(directory, "out", "control.csv"), "utf-8").trim().split("\n")
console.log(`out/control.csv (${control.length - 1} intentos registrados):`)
for (const l of control) console.log(`  ${l.replace(/,[^,]*$/, "")}`) // sin la columna ts
verificar(
  control.some((l) => l.startsWith("SOL-2026-005,creada,") && l.includes(",true,")),
  "out/control.csv marca la OC de sol-005 con retroactiva = true",
)

linea("═")
console.log(fallas.length === 0 ? "RESULTADO: 6/6 casos coinciden con spec/reglas.md · idempotencia y confirmaciones OK" : `RESULTADO: ${fallas.length} verificación(es) fallida(s)`)
for (const f of fallas) console.log(`  ✘ ${f}`)
linea("═")
process.exit(fallas.length === 0 ? 0 : 1)
