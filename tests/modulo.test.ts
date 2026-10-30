import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import * as moduloTools from "../modulo/tools/oc.ts"
import { generar } from "../scripts/empaquetar-modulo.ts"
import * as appTools from "../src/tools/oc.ts"

// PRD §9.4: las tres piezas del módulo deben ser las mismas que usa la aplicación.
const raiz = path.resolve(import.meta.dir, "..")

test("modulo/ coincide con las fuentes (regenerar con bun run scripts/empaquetar-modulo.ts)", () => {
  for (const [ruta, esperado] of Object.entries(generar())) {
    expect(readFileSync(path.join(raiz, ruta), "utf-8")).toBe(esperado)
  }
})

test("las herramientas del módulo son los mismos objetos que las de la app", () => {
  expect(moduloTools.herramientas).toBe(appTools.herramientas)
  expect(Object.keys(moduloTools.herramientas)).toEqual(["leer_paquete", "validar", "construir_payload", "generar_evidencia", "crear", "leer_excel"])
})
