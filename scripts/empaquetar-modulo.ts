// Genera modulo/ (PRD §9.4) desde las MISMAS fuentes que usa la aplicación:
//   agent/prompt.md             → modulo/agent.md (frontmatter + mismo cuerpo)
//   src/knowledge/*.md          → modulo/skill/ordenes-compra/SKILL.md (frontmatter + mismo cuerpo)
//   src/tools/oc.ts             → modulo/tools/oc.ts (re-exporta, no copia)
// tests/modulo.test.ts falla si el módulo diverge de las fuentes.
// Uso: bun run scripts/empaquetar-modulo.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const raiz = path.resolve(import.meta.dir, "..")
const leer = (r: string) => readFileSync(path.join(raiz, r), "utf-8")

export const FRONTMATTER_AGENTE = `---
description: Agente de órdenes de compra SAP. Lee el paquete de una solicitud, valida RC1–RC10 contra los maestros, construye la OC y la crea en SAP con confirmación humana de las excepciones.
mode: primary
permission:
  edit: deny
  bash: deny
---

`

export const FRONTMATTER_SKILL = `---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra de Periferia IT Group (reglas RC1–RC10, códigos de motivo con acción sugerida, estructura de la OC y política de compras retroactivas). Usar al procesar o explicar solicitudes de compra.
---

`

export const TOOLS_REEXPORT = `// Las mismas herramientas que usa la aplicación (no es una copia): importables sin el servidor.
// Contrato PRD §6.2: cada export es { description, args, execute(args, ctx) } y el modelo la ve como oc_<export>.
export * from "../../src/tools/oc.ts"
`

export function generar() {
  const archivos: Record<string, string> = {
    "modulo/agent.md": FRONTMATTER_AGENTE + leer("agent/prompt.md"),
    "modulo/skill/ordenes-compra/SKILL.md": FRONTMATTER_SKILL + leer("src/knowledge/ordenes-compra.md"),
    "modulo/tools/oc.ts": TOOLS_REEXPORT,
  }
  return archivos
}

if (import.meta.main) {
  for (const [ruta, contenido] of Object.entries(generar())) {
    mkdirSync(path.dirname(path.join(raiz, ruta)), { recursive: true })
    writeFileSync(path.join(raiz, ruta), contenido, "utf-8")
    console.log(`✔ ${ruta}`)
  }
}
