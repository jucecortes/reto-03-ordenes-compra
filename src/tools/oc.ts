import { appendFile, mkdir, writeFile, access } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { etiqueta, evaluar, type Evaluacion } from "../domain/evaluar.ts"
import { archivoEvidenciaPdf, archivoEvidenciaTxt, sha256, textoEvidencia } from "../domain/evidencia.ts"
import { construirPayload, huellaPayload } from "../domain/payload.ts"
import { leerExcel } from "../fixtures/excel.ts"
import { leerMaestros, leerPaquete, type Resultado } from "../fixtures/lector.ts"
import type { Maestros } from "../schemas/maestros.ts"
import { ordenCompraSchema, type OrdenCompra } from "../schemas/orden.ts"
import type { Paquete } from "../schemas/paquete.ts"
import type { SapAdapter } from "../sap/adapter.ts"
import { SapMock } from "../sap/mock.ts"

// Herramientas del agente (PRD §6.2). Cada export es { description, args, execute } y el modelo
// la ve como oc_<export>. execute valida los argumentos con zod, nunca lanza y devuelve un string
// JSON { ok: true, data } | { ok: false, error }. Las usan igual el ciclo del agente y demo.ts.

export type Contexto = {
  /** Raíz del proyecto: todas las rutas se resuelven desde aquí. */
  directory: string
  sessionId: string
  /** Quién confirmó, para excepciones[].confirmado_por (A16). Lo fija el backend, no el modelo. */
  confirmadoPor?: string
}

type Respuesta = { ok: true; data: unknown } | { ok: false; error: string }

export type Herramienta<S extends z.ZodRawShape> = {
  description: string
  args: S
  execute(args: z.infer<z.ZodObject<S>>, ctx: Contexto): Promise<string>
}

// ---------- infraestructura compartida ----------

const cacheMaestros = new Map<string, Maestros>()
const cacheSap = new Map<string, SapAdapter>()

async function maestros(directory: string): Promise<Resultado<Maestros>> {
  const enCache = cacheMaestros.get(directory)
  if (enCache) return { ok: true, data: enCache }
  const r = await leerMaestros(directory)
  if (r.ok) cacheMaestros.set(directory, r.data)
  return r
}

/** Adaptador SAP por directorio. setSap permite inyectar otro (pruebas o adaptador real). */
async function sap(directory: string, m: Maestros): Promise<SapAdapter> {
  let s = cacheSap.get(directory)
  if (!s) {
    s = new SapMock(rutaOut(directory), m.proveedores)
    cacheSap.set(directory, s)
  }
  return s
}
export function setSap(directory: string, adaptador: SapAdapter): void {
  cacheSap.set(directory, adaptador)
}
/** demo.ts limpia out/: se descarta también la caché del adaptador sobre esos archivos. */
export function reiniciarEstado(): void {
  cacheMaestros.clear()
  cacheSap.clear()
}

export const rutaOut = (directory: string, ...partes: string[]) => path.join(directory, "out", ...partes)
const relativa = (directory: string, ruta: string) => path.relative(directory, ruta).replaceAll("\\", "/")

async function registrarLlamada(ctx: Contexto, herramienta: string, args: unknown, r: Respuesta, ms: number): Promise<void> {
  const argsTexto = JSON.stringify(args)
  const fila = {
    ts: new Date().toISOString(),
    sessionId: ctx.sessionId,
    herramienta: `oc_${herramienta}`,
    args: argsTexto.length > 2000 ? `${argsTexto.slice(0, 2000)}…` : JSON.parse(argsTexto),
    ok: r.ok,
    ...(r.ok ? {} : { error: r.error }),
    ms,
  }
  try {
    await mkdir(rutaOut(ctx.directory), { recursive: true })
    await appendFile(rutaOut(ctx.directory, "log.jsonl"), `${JSON.stringify(fila)}\n`, "utf-8")
  } catch {
    // El log nunca debe tumbar una herramienta.
  }
}

/** Envuelve la lógica: valida args con zod, captura cualquier excepción, registra en out/log.jsonl (CA4). */
function definir<S extends z.ZodRawShape>(
  nombre: string,
  description: string,
  args: S,
  ejecutar: (args: z.infer<z.ZodObject<S>>, ctx: Contexto) => Promise<Respuesta>,
): Herramienta<S> {
  const schema = z.object(args)
  return {
    description,
    args,
    async execute(entrada, ctx) {
      const inicio = Date.now()
      let r: Respuesta
      const validada = schema.safeParse(entrada)
      if (!validada.success) r = { ok: false, error: `Argumentos inválidos para oc_${nombre}: ${z.prettifyError(validada.error)}` }
      else {
        try {
          r = await ejecutar(validada.data, ctx)
        } catch (e) {
          r = { ok: false, error: `Error inesperado en oc_${nombre}: ${(e as Error).message}` }
        }
      }
      await registrarLlamada(ctx, nombre, entrada, r, Date.now() - inicio)
      return JSON.stringify(r)
    },
  }
}

type Contexto3 = { paquete: Paquete; maestros: Maestros; evaluacion: Evaluacion }

/** Relee el caso desde fixtures y lo evalúa: las herramientas nunca confían en datos que reenvía el modelo. */
async function cargarYEvaluar(directory: string, caso: string): Promise<Resultado<Contexto3>> {
  const m = await maestros(directory)
  if (!m.ok) return m
  const p = await leerPaquete(directory, caso)
  if (!p.ok) return p
  return { ok: true, data: { paquete: p.data, maestros: m.data, evaluacion: evaluar(p.data, m.data) } }
}

type Evidencia = { ruta: string; sha256: string; ruta_pdf: string }

/** HU-4: P0 aprobacion.txt (encabezados, cuerpo y sha256) y P1 aprobacion.pdf con el mismo contenido. */
async function escribirEvidencia(directory: string, paquete: Paquete): Promise<Resultado<Evidencia>> {
  if (!paquete.aprobacion) return { ok: false, error: `${paquete.caso}: no hay correo de aprobación para generar la evidencia.` }
  const contenido = textoEvidencia(paquete.caso, paquete.aprobacion)
  const txt = rutaOut(directory, paquete.caso, "aprobacion.txt")
  const pdf = rutaOut(directory, paquete.caso, "aprobacion.pdf")
  await mkdir(path.dirname(txt), { recursive: true })
  await writeFile(txt, archivoEvidenciaTxt(contenido), "utf-8")
  await writeFile(pdf, await archivoEvidenciaPdf(contenido, paquete.aprobacion.fecha))
  return { ok: true, data: { ruta: relativa(directory, txt), sha256: sha256(contenido), ruta_pdf: relativa(directory, pdf) } }
}

type FilaControl = {
  solicitud_id: string
  resultado: "creada" | "idempotente" | "bloqueada" | "pendiente_confirmacion" | "rechazada"
  numero_oc: string
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
}

const csv = (v: string) => (/[",\n;]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)

/** HU-5: cada intento de creación agrega una fila a out/control.csv. */
async function registrarControl(directory: string, f: FilaControl): Promise<void> {
  const ruta = rutaOut(directory, "control.csv")
  await mkdir(path.dirname(ruta), { recursive: true })
  const existe = await access(ruta).then(() => true, () => false)
  const encabezado = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n"
  const fila = [f.solicitud_id, f.resultado, f.numero_oc, String(f.retroactiva), f.bloqueos.join(";"), f.confirmaciones.join(";"), new Date().toISOString()]
    .map(csv)
    .join(",")
  await appendFile(ruta, `${existe ? "" : encabezado}${fila}\n`, "utf-8")
}

const caso = z.string().describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, por ejemplo sol-001")
const ignorado = (que: string) =>
  z.unknown().optional().describe(`Opcional. Se ignora: la herramienta relee ${que} desde los fixtures para no depender de datos reenviados`)

// ---------- herramientas ----------

export const leer_paquete = definir(
  "leer_paquete",
  "Lee y normaliza el paquete de una solicitud (correo, solicitud, cotización, aprobación y factura si existe); los adjuntos ausentes vienen en null y se listan en faltantes.",
  { caso },
  async ({ caso }, ctx) => {
    const p = await leerPaquete(ctx.directory, caso)
    return p.ok ? { ok: true, data: p.data } : { ok: false, error: `${p.error}. Pide al solicitante el paquete completo.` }
  },
)

export const validar = definir(
  "validar",
  "Aplica las reglas de control RC1–RC10 al caso y devuelve si es apta, los bloqueos, las confirmaciones requeridas, los valores derivados de maestros y si es una compra retroactiva.",
  { caso, paquete: ignorado("el paquete") },
  async ({ caso }, ctx) => {
    const c = await cargarYEvaluar(ctx.directory, caso)
    if (!c.ok) return c
    const e = c.data.evaluacion
    return {
      ok: true,
      data: {
        solicitud_id: c.data.paquete.solicitud.solicitud_id,
        apta: e.apta,
        bloqueos: e.bloqueos,
        confirmaciones: e.confirmaciones,
        derivados: e.derivados,
        retroactiva: e.retroactiva,
        impuestos: e.impuestos,
        controles: e.controles.map((r) => ({ regla: r.regla, ok: r.ok, tipo: r.tipo, codigo: r.codigo, detalle: r.detalle })),
      },
    }
  },
)

export const construir_payload = definir(
  "construir_payload",
  "Construye la orden de compra exactamente como quedaría en SAP (esquema §7.4) para un caso apto y guarda su trazabilidad campo a campo en out/<caso>/trazabilidad.json.",
  { caso, paquete: ignorado("el paquete"), derivados: ignorado("los derivados") },
  async ({ caso }, ctx) => {
    const c = await cargarYEvaluar(ctx.directory, caso)
    if (!c.ok) return c
    const r = construirPayload(c.data.paquete, c.data.evaluacion, c.data.maestros)
    if (!r.ok) return r
    const ruta = rutaOut(ctx.directory, caso, "trazabilidad.json")
    await mkdir(path.dirname(ruta), { recursive: true })
    await writeFile(ruta, `${JSON.stringify(r.trazabilidad, null, 2)}\n`, "utf-8")
    return { ok: true, data: { orden: r.orden, huella: huellaPayload(r.orden), trazabilidad: relativa(ctx.directory, ruta) } }
  },
)

export const generar_evidencia = definir(
  "generar_evidencia",
  "Genera la evidencia de aprobación del caso (out/<caso>/aprobacion.txt y aprobacion.pdf con encabezados, cuerpo del correo y sha256) y devuelve sus rutas y el sha256.",
  { caso },
  async ({ caso }, ctx) => {
    const p = await leerPaquete(ctx.directory, caso)
    if (!p.ok) return p
    return escribirEvidencia(ctx.directory, p.data)
  },
)

export const crear = definir(
  "crear",
  "Crea la orden de compra en SAP (simulado) con el payload de oc_construir_payload; si el caso tiene confirmaciones solo procede con confirmado=true tras la aprobación explícita del usuario, y es idempotente por solicitud.",
  {
    caso,
    // Se valida dentro, después de los bloqueos: un intento sobre un caso bloqueado también se registra (HU-5).
    payload: z.unknown().describe("Objeto `orden` devuelto por oc_construir_payload (esquema OrdenCompra §7.4), sin modificar"),
    confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente las excepciones en su último mensaje"),
  },
  async ({ caso, payload, confirmado }, ctx) => {
    const c = await cargarYEvaluar(ctx.directory, caso)
    if (!c.ok) return c
    const { paquete, evaluacion: e, maestros: m } = c.data
    const sol = paquete.solicitud
    const base = { solicitud_id: sol.solicitud_id, retroactiva: e.retroactiva, bloqueos: e.bloqueos.map(etiqueta), confirmaciones: e.confirmaciones.map(etiqueta) }

    // 1. Bloqueos: nunca se crea (HU-5).
    if (!e.apta) {
      await registrarControl(ctx.directory, { ...base, resultado: "bloqueada", numero_oc: "" })
      return { ok: false, error: `No se puede crear la OC de ${caso}: ${e.bloqueos.map((b) => `${etiqueta(b)} — ${b.detalle}`).join(" | ")}` }
    }

    // 2. El payload debe ser el validado: el modelo no puede alterar montos ni datos (PRD §10).
    const canonico = construirPayload(paquete, e, m)
    if (!canonico.ok) return canonico
    const recibido = ordenCompraSchema.safeParse(payload)
    if (!recibido.success || huellaPayload(recibido.data) !== huellaPayload(canonico.orden)) {
      await registrarControl(ctx.directory, { ...base, resultado: "rechazada", numero_oc: "" })
      return { ok: false, error: `El payload recibido no coincide con el que construyó oc_construir_payload para ${caso}. Vuelve a construirlo y envíalo sin modificar.` }
    }

    // 3. Idempotencia: la misma solicitud devuelve la OC existente.
    const adaptador = await sap(ctx.directory, m)
    const previa = await adaptador.buscarOrdenPorReferencia(sol.solicitud_id)
    if (previa) {
      await registrarControl(ctx.directory, { ...base, resultado: "idempotente", numero_oc: previa.numero_oc })
      // La interfaz exige solo numero_oc; si el adaptador informa la fecha original, se devuelve.
      const fecha = "fecha" in previa && typeof previa.fecha === "string" ? previa.fecha : null
      return { ok: true, data: { numero_oc: previa.numero_oc, fecha, idempotente: true, retroactiva: e.retroactiva } }
    }

    // 4. Confirmación humana (CA3): con excepciones, solo con confirmado = true.
    if (e.confirmaciones.length > 0 && confirmado !== true) {
      await registrarControl(ctx.directory, { ...base, resultado: "pendiente_confirmacion", numero_oc: "" })
      return {
        ok: false,
        error: `Requiere confirmación explícita del usuario antes de crear la OC: ${e.confirmaciones.map((x) => `${etiqueta(x)} — ${x.detalle}`).join(" | ")}`,
      }
    }

    // 5. Evidencia adjunta (HU-4) y excepciones con quién confirmó (A16).
    const evidencia = await escribirEvidencia(ctx.directory, paquete)
    if (!evidencia.ok) return evidencia
    const confirmadoPor = e.confirmaciones.length ? (ctx.confirmadoPor ?? `analista (sesión ${ctx.sessionId})`) : null
    const orden: OrdenCompra = { ...canonico.orden, excepciones: canonico.orden.excepciones.map((x) => ({ ...x, confirmado_por: confirmadoPor })) }

    const r = await adaptador.crearOrden(orden)
    await registrarControl(ctx.directory, { ...base, resultado: "creada", numero_oc: r.numero_oc })
    return { ok: true, data: { numero_oc: r.numero_oc, fecha: r.fecha, idempotente: false, retroactiva: e.retroactiva, evidencia: evidencia.data } }
  },
)

export const leer_excel = definir(
  "leer_excel",
  "Lee un archivo .xlsx del proyecto (por ejemplo una solicitud.xlsx) y devuelve las filas de la primera hoja; si las columnas son las de una solicitud, valida cada fila con el esquema de solicitud.",
  { ruta: z.string().describe("Ruta relativa al proyecto de un archivo .xlsx, por ejemplo ejemplos/solicitudes.xlsx") },
  async ({ ruta }, ctx) => leerExcel(ctx.directory, ruta),
)

/** Registro de herramientas: el nombre que ve el modelo es oc_<export> (PRD §6.2). */
export const herramientas = { leer_paquete, validar, construir_payload, generar_evidencia, crear, leer_excel }
export type NombreHerramienta = `oc_${keyof typeof herramientas}`

/**
 * Ejecuta una herramienta por nombre (con o sin el prefijo oc_) y argumentos sin tipar: la propia
 * herramienta los valida con zod. Lo usan el ciclo del agente y demo.ts. Nunca lanza.
 */
export async function ejecutarHerramienta(nombre: string, args: unknown, ctx: Contexto): Promise<string> {
  const clave = nombre.replace(/^oc_/, "") as keyof typeof herramientas
  const h = herramientas[clave] as { execute: (a: unknown, c: Contexto) => Promise<string> } | undefined
  if (!h) return JSON.stringify({ ok: false, error: `Herramienta desconocida: ${nombre}` })
  return h.execute(args, ctx)
}
