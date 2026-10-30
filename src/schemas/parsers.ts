import { cotizacionSchema, facturaSchema, type Cotizacion, type Factura } from "./paquete.ts"
import { normalizarNit, parsearPesos, sumarDias } from "./valores.ts"

// Parsers deterministas del texto de cotización y factura (PDF ya convertido a texto).
// No usan el modelo: si el formato no se reconoce devuelven un error legible, nunca suponen datos.

export type ResultadoParseo<T> = { ok: true; data: T } | { ok: false; error: string }

const linea = (texto: string, re: RegExp): string | null => re.exec(texto)?.[1]?.trim() ?? null

export function parsearCotizacion(texto: string): ResultadoParseo<Cotizacion> {
  try {
    const t = texto.replace(/\r\n?/g, "\n")
    const proveedor = linea(t, /^Proveedor:\s*(.+)$/m)
    const totalTxt = linea(t, /^TOTAL[^:\n]*:\s*(.+)$/m)
    if (!proveedor) throw new Error("no se encontró la línea 'Proveedor:'")
    if (!totalTxt) throw new Error("no se encontró la línea 'TOTAL'")

    const items = [...t.matchAll(/^(\d+)\.\s*(.+?)\s*\|\s*Cantidad:\s*([\d.,]+)\s*\|\s*Precio unitario[^:]*:\s*([^|]+?)\s*\|\s*Subtotal:\s*(.+)$/gm)].map(
      (m) => ({
        numero: Number(m[1]),
        descripcion: m[2]!.trim(),
        cantidad: parsearPesos(m[3]!),
        precio_unitario: parsearPesos(m[4]!),
        subtotal: parsearPesos(m[5]!),
      }),
    )
    const fecha = linea(t, /^Fecha:\s*(\d{4}-\d{2}-\d{2})/m)
    const diasValidez = linea(t, /^Validez de la oferta:\s*(\d+)\s*d[ií]as/im)
    const nitTxt = linea(t, /^NIT:\s*([\d.\-]+)/m)
    const ivaLinea = /^IVA\s*(\d+(?:[.,]\d+)?)\s*%:\s*(.+)$/m.exec(t)
    const baseTxt = linea(t, /^Base gravable:\s*(.+)$/m)

    const cotizacion = {
      referencia: linea(t, /^COTIZACI[ÓO]N\s+(\S+)/m),
      fecha,
      proveedor,
      nit: nitTxt ? normalizarNit(nitTxt) : null,
      items,
      base: baseTxt ? parsearPesos(baseTxt) : null,
      iva: ivaLinea ? parsearPesos(ivaLinea[2]!) : null,
      tasa_iva: ivaLinea ? Number(ivaLinea[1]!.replace(",", ".")) / 100 : null,
      total: parsearPesos(totalTxt),
      moneda: /\bUSD\b/.test(totalTxt) ? "USD" : "COP",
      // A17: fecha + días de validez; solo informativo (el PRD no define regla de vencimiento).
      validez_hasta: fecha && diasValidez ? sumarDias(fecha, Number(diasValidez)) : null,
      texto: t,
    }
    return { ok: true, data: cotizacionSchema.parse(cotizacion) }
  } catch (e) {
    return { ok: false, error: `cotización ilegible: ${(e as Error).message}` }
  }
}

export function parsearFactura(texto: string): ResultadoParseo<Factura> {
  try {
    const t = texto.replace(/\r\n?/g, "\n")
    const numero = linea(t, /FACTURA[^\n]*?No\.\s*(\S+)/i)
    const fecha = linea(t, /^Fecha de emisi[óo]n:\s*(\d{4}-\d{2}-\d{2})/im)
    const totalTxt = linea(t, /^TOTAL:\s*(.+)$/m)
    if (!numero) throw new Error("no se encontró el número de factura")
    if (!fecha) throw new Error("no se encontró la fecha de emisión")
    if (!totalTxt) throw new Error("no se encontró el TOTAL")
    const nitTxt = linea(t, /^Vendedor:.*?NIT\s*([\d.\-]+)/im)
    return {
      ok: true,
      data: facturaSchema.parse({ numero, fecha, total: parsearPesos(totalTxt), nit: nitTxt ? normalizarNit(nitTxt) : null }),
    }
  } catch (e) {
    return { ok: false, error: `factura ilegible: ${(e as Error).message}` }
  }
}
