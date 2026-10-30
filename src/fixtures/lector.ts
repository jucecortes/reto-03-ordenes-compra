import { readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { contieneAprobado } from "../domain/aprobacion.ts"
import { aprobacionSchema, correoSchema, solicitudSchema } from "../schemas/documentos.ts"
import {
  centroCostoSchema,
  condicionPagoSchema,
  indicadorIvaSchema,
  maestrosSchema,
  proveedorSchema,
  type Maestros,
} from "../schemas/maestros.ts"
import { paqueteSchema, type Paquete } from "../schemas/paquete.ts"
import { parsearCotizacion, parsearFactura } from "../schemas/parsers.ts"

// Lectura de fixtures/reto-03 (solo lectura). Todas las rutas se resuelven desde `directory`
// (raíz del proyecto, PRD §6.2), nunca absolutas. Ninguna función lanza: devuelven { ok, ... }.

export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }

export const CASO_VALIDO = /^sol-\d{3}$/

const rutaFixtures = (directory: string, ...partes: string[]) => path.join(directory, "fixtures", "reto-03", ...partes)

type Lectura = { tipo: "ok"; texto: string } | { tipo: "ausente" } | { tipo: "error"; motivo: string }

async function leerTexto(ruta: string): Promise<Lectura> {
  try {
    return { tipo: "ok", texto: await readFile(ruta, "utf-8") }
  } catch (e) {
    const codigo = (e as NodeJS.ErrnoException).code
    return codigo === "ENOENT" ? { tipo: "ausente" } : { tipo: "error", motivo: (e as Error).message }
  }
}

function parsearJson<T>(texto: string, schema: z.ZodType<T>, nombre: string): Resultado<T> {
  let crudo: unknown
  try {
    crudo = JSON.parse(texto)
  } catch {
    return { ok: false, error: `${nombre}: JSON malformado` }
  }
  const r = schema.safeParse(crudo)
  return r.success ? { ok: true, data: r.data } : { ok: false, error: `${nombre}: ${z.prettifyError(r.error)}` }
}

async function leerMaestro<T>(directory: string, nombre: string, schema: z.ZodType<T>): Promise<Resultado<T>> {
  const l = await leerTexto(rutaFixtures(directory, "maestros", nombre))
  if (l.tipo !== "ok") return { ok: false, error: `maestro ${nombre}: ${l.tipo === "ausente" ? "no existe" : l.motivo}` }
  return parsearJson(l.texto, schema, `maestro ${nombre}`)
}

export async function leerMaestros(directory: string): Promise<Resultado<Maestros>> {
  const proveedores = await leerMaestro(directory, "proveedores.json", z.array(proveedorSchema))
  if (!proveedores.ok) return proveedores
  const centrosCosto = await leerMaestro(directory, "centros-costo.json", z.array(centroCostoSchema))
  if (!centrosCosto.ok) return centrosCosto
  const indicadoresIva = await leerMaestro(directory, "indicadores-iva.json", z.array(indicadorIvaSchema))
  if (!indicadoresIva.ok) return indicadoresIva
  const condicionesPago = await leerMaestro(directory, "condiciones-pago.json", z.array(condicionPagoSchema))
  if (!condicionesPago.ok) return condicionesPago
  return {
    ok: true,
    data: maestrosSchema.parse({
      proveedores: proveedores.data,
      centrosCosto: centrosCosto.data,
      indicadoresIva: indicadoresIva.data,
      condicionesPago: condicionesPago.data,
    }),
  }
}

/** Lee y normaliza el paquete de un caso (PRD §7.2, HU-1, HU-6). */
export async function leerPaquete(directory: string, caso: string): Promise<Resultado<Paquete>> {
  // El nombre del caso viene del modelo o del usuario: se valida antes de tocar el disco.
  if (!CASO_VALIDO.test(caso)) return { ok: false, error: `caso inválido "${caso}": se espera el formato sol-NNN` }
  const dir = (nombre: string) => rutaFixtures(directory, "solicitudes", caso, nombre)
  const faltantes: Paquete["faltantes"] = []
  const marcar = (adjunto: string, motivo: string) => faltantes.push({ adjunto, motivo })
  const motivoLectura = (l: Exclude<Lectura, { tipo: "ok" }>) => (l.tipo === "ausente" ? "no viene en el paquete" : l.motivo)

  // La solicitud es indispensable: sin ella no hay nada que validar (A11).
  const lSol = await leerTexto(dir("solicitud.json"))
  if (lSol.tipo === "ausente") return { ok: false, error: `${caso}: falta solicitud.json; pedir al solicitante el Excel de solicitud` }
  if (lSol.tipo === "error") return { ok: false, error: `${caso}: no se pudo leer solicitud.json (${lSol.motivo})` }
  const solicitud = parsearJson(lSol.texto, solicitudSchema, "solicitud.json")
  if (!solicitud.ok) return { ok: false, error: `${caso}: ${solicitud.error}` }

  let correo: Paquete["correo"] = null
  const lCorreo = await leerTexto(dir("correo.json"))
  if (lCorreo.tipo === "ok") {
    const r = parsearJson(lCorreo.texto, correoSchema, "correo.json")
    if (r.ok) correo = { id: r.data.id, de: r.data.de, asunto: r.data.asunto, fecha: r.data.fecha }
    else marcar("correo.json", r.error)
  } else marcar("correo.json", motivoLectura(lCorreo))

  let cotizacion: Paquete["cotizacion"] = null
  const lCot = await leerTexto(dir("cotizacion.txt"))
  if (lCot.tipo === "ok") {
    const r = parsearCotizacion(lCot.texto)
    if (r.ok) cotizacion = r.data
    else marcar("cotizacion.txt", r.error)
  } else marcar("cotizacion.txt", motivoLectura(lCot))

  let aprobacion: Paquete["aprobacion"] = null
  const lApr = await leerTexto(dir("aprobacion.json"))
  if (lApr.tipo === "ok") {
    const r = parsearJson(lApr.texto, aprobacionSchema, "aprobacion.json")
    if (r.ok) {
      aprobacion = {
        de: r.data.de.trim().toLowerCase(),
        fecha: r.data.fecha,
        aprobado: contieneAprobado(r.data.cuerpo),
        texto: r.data.cuerpo,
        asunto: r.data.asunto,
        para: r.data.para ?? null,
      }
    } else marcar("aprobacion.json", r.error)
  } else marcar("aprobacion.json", motivoLectura(lApr))

  // La factura es opcional: su ausencia es el caso normal y no se reporta como faltante.
  let factura: Paquete["factura"] = null
  const lFac = await leerTexto(dir("factura.txt"))
  if (lFac.tipo === "ok") {
    const r = parsearFactura(lFac.texto)
    if (r.ok) factura = r.data
    else marcar("factura.txt", r.error)
  } else if (lFac.tipo === "error") marcar("factura.txt", lFac.motivo)

  return { ok: true, data: paqueteSchema.parse({ caso, correo, solicitud: solicitud.data, cotizacion, aprobacion, factura, faltantes }) }
}
