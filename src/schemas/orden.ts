import { z } from "zod"

// Payload de la OC (PRD §7.4), validado con zod antes de escribirse o enviarse a SAP.

export const posicionSchema = z.object({
  numero: z.number().int().positive(),
  descripcion: z.string().min(1).max(40, "máx. 40 caracteres (texto breve SAP)"),
  cantidad: z.number().positive(),
  unidad: z.enum(["UN", "H", "MES"]),
  precio_unitario: z.number().nonnegative(),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  indicador_iva: z.string().min(1),
})

export const ordenCompraSchema = z.object({
  referencia: z.object({ solicitud_id: z.string().min(1), correo_id: z.string().min(1), cotizacion_ref: z.string().nullable() }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string().min(1), nit: z.string().min(1), nombre: z.string().min(1) }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string().min(1),
  aprobador: z.object({ email: z.string().email(), fecha_aprobacion: z.string().min(1), evidencia_sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  posiciones: z.array(posicionSchema).min(1),
  excepciones: z.array(z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() })),
})

export type OrdenCompra = z.infer<typeof ordenCompraSchema>

/** Fuente de cada valor del payload: exactamente las que admite el PRD (HU-3). El detalle va en `nota`. */
export type Fuente = "solicitud" | "cotizacion" | "derivado" | `maestro.${string}`
export type Trazabilidad = Record<string, { valor: unknown; fuente: Fuente; nota?: string }>
