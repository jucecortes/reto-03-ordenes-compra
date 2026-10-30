import { z } from "zod"

// Maestros de fixtures/reto-03/maestros (PRD §7.1). Los tipos se derivan con z.infer:
// esquema y tipo son una sola fuente de verdad.

export const proveedorSchema = z.object({
  codigo_sap: z.string().min(1),
  nit: z.string().regex(/^\d+$/, "NIT solo dígitos, sin DV"),
  nombre: z.string().min(1),
  condiciones_pago_default: z.string().min(1),
  indicador_iva_default: z.string().min(1),
  activo: z.boolean(),
})

export const aprobadorSchema = z.object({
  email: z.string().email(),
  nombre: z.string().optional(),
  tope: z.number().nonnegative(),
})

export const centroCostoSchema = z.object({
  centro_costo: z.string().min(1),
  nombre: z.string().optional(),
  subareas: z.array(z.string().min(1)),
  aprobadores: z.array(aprobadorSchema),
})

export const indicadorIvaSchema = z.object({
  codigo: z.string().min(1),
  descripcion: z.string(),
  tasa: z.number().min(0).max(1),
})

export const condicionPagoSchema = z.object({
  codigo: z.string().min(1),
  descripcion: z.string(),
  dias: z.number().int().nonnegative(),
})

export const maestrosSchema = z.object({
  proveedores: z.array(proveedorSchema),
  centrosCosto: z.array(centroCostoSchema),
  indicadoresIva: z.array(indicadorIvaSchema),
  condicionesPago: z.array(condicionPagoSchema),
})

export type Proveedor = z.infer<typeof proveedorSchema>
export type Aprobador = z.infer<typeof aprobadorSchema>
export type CentroCosto = z.infer<typeof centroCostoSchema>
export type IndicadorIva = z.infer<typeof indicadorIvaSchema>
export type CondicionPago = z.infer<typeof condicionPagoSchema>
export type Maestros = z.infer<typeof maestrosSchema>
