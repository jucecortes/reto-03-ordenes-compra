import { z } from "zod"
import { solicitudSchema } from "./documentos.ts"

// Paquete normalizado (PRD §7.2). Los campos del PRD se conservan con su nombre; los extra
// (referencia, items, base, iva, tasa) los usa el dominio para trazabilidad y RC5.

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const itemCotizacionSchema = z.object({
  numero: z.number().int().positive(),
  descripcion: z.string(),
  cantidad: z.number().positive(),
  precio_unitario: z.number().nonnegative(),
  subtotal: z.number().nonnegative(),
})

export const cotizacionSchema = z.object({
  referencia: z.string().nullable(),
  fecha: fecha.nullable(),
  proveedor: z.string(),
  nit: z.string().nullable(),
  items: z.array(itemCotizacionSchema),
  base: z.number().nonnegative().nullable(),
  iva: z.number().nonnegative().nullable(),
  tasa_iva: z.number().min(0).max(1).nullable(),
  total: z.number().nonnegative(),
  moneda: z.string(),
  validez_hasta: fecha.nullable(),
  texto: z.string(),
})

export const facturaSchema = z.object({
  numero: z.string(),
  fecha,
  total: z.number().nonnegative(),
  nit: z.string().nullable(),
})

export const aprobacionPaqueteSchema = z.object({
  de: z.string(),
  fecha: z.string(),
  aprobado: z.boolean(),
  texto: z.string(),
  asunto: z.string(),
  para: z.string().nullable(),
})

export const paqueteSchema = z.object({
  caso: z.string(),
  correo: z.object({ id: z.string(), de: z.string(), asunto: z.string(), fecha: z.string() }).nullable(),
  solicitud: solicitudSchema,
  cotizacion: cotizacionSchema.nullable(),
  aprobacion: aprobacionPaqueteSchema.nullable(),
  factura: facturaSchema.nullable(),
  /** Adjuntos ausentes o ilegibles, con su nombre (HU-1): nunca se lanza excepción por ellos. */
  faltantes: z.array(z.object({ adjunto: z.string(), motivo: z.string() })),
})

export type ItemCotizacion = z.infer<typeof itemCotizacionSchema>
export type Cotizacion = z.infer<typeof cotizacionSchema>
export type Factura = z.infer<typeof facturaSchema>
export type AprobacionPaquete = z.infer<typeof aprobacionPaqueteSchema>
export type Paquete = z.infer<typeof paqueteSchema>
