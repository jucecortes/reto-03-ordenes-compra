import { z } from "zod"

// Documentos de cada caso (PRD §7.1). Montos tal como vienen en los documentos (pesos);
// el dominio los convierte a centavos enteros antes de comparar (src/schemas/valores.ts).

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha YYYY-MM-DD")
const fechaHora = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "fecha-hora ISO 8601")
const monto = z.number({ error: "monto no numérico" }).finite().nonnegative()

export const correoSchema = z.object({
  id: z.string().min(1),
  de: z.string().min(1),
  para: z.string().optional(),
  asunto: z.string(),
  fecha: fechaHora,
  cuerpo: z.string(),
  adjuntos: z.array(z.string()),
})

export const solicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string().min(1),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().min(1).optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: z.number({ error: "cantidad no numérica" }).finite().positive(),
  valor_unitario: monto,
  valor_total: monto,
  moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().min(1).optional(),
  condiciones_pago: z.string().min(1).optional(),
  fecha_solicitud: fecha,
})

export const aprobacionSchema = z.object({
  de: z.string().min(1),
  para: z.string().optional(),
  cc: z.array(z.string()).optional(),
  fecha: fechaHora,
  asunto: z.string(),
  cuerpo: z.string(),
})

export type Correo = z.infer<typeof correoSchema>
export type Solicitud = z.infer<typeof solicitudSchema>
export type AprobacionDoc = z.infer<typeof aprobacionSchema>
