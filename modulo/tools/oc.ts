// Las mismas herramientas que usa la aplicación (no es una copia): importables sin el servidor.
// Contrato PRD §6.2: cada export es { description, args, execute(args, ctx) } y el modelo la ve como oc_<export>.
export * from "../../src/tools/oc.ts"
