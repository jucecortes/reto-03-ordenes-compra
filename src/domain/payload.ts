import { ordenCompraSchema, type OrdenCompra, type Trazabilidad } from "../schemas/orden.ts"
import type { Maestros } from "../schemas/maestros.ts"
import type { Paquete } from "../schemas/paquete.ts"
import { fechaBogota } from "../schemas/valores.ts"
import { etiqueta, type Evaluacion } from "./evaluar.ts"
import { sha256, textoEvidencia } from "./evidencia.ts"
import { buscarProveedor } from "./reglas.ts"

// Construcción del payload (PRD §7.4, HU-3). Cada valor queda trazado a su fuente.

export const LIMITE_DESCRIPCION = 40

/** A14: trunca a 40 caracteres sin cortar una palabra si el corte deja al menos la mitad del texto. */
export function truncarDescripcion(texto: string, max = LIMITE_DESCRIPCION): string {
  const limpio = texto.replace(/\s+/g, " ").trim()
  if (limpio.length <= max) return limpio
  const corte = limpio.slice(0, max + 1).lastIndexOf(" ")
  return (corte >= max / 2 ? limpio.slice(0, corte) : limpio.slice(0, max)).replace(/[\s,;:.-]+$/, "")
}

/** A13: H si el ítem cotizado se vende por hora; UN en cualquier otro caso. */
export function derivarUnidad(cotizacion: Paquete["cotizacion"]): "UN" | "H" {
  const item = cotizacion?.items[0]?.descripcion ?? ""
  return /^horas?\b/i.test(item.trim()) ? "H" : "UN"
}

export type ResultadoPayload = { ok: true; orden: OrdenCompra; trazabilidad: Trazabilidad } | { ok: false; error: string }

export function construirPayload(paquete: Paquete, evaluacion: Evaluacion, maestros: Maestros): ResultadoPayload {
  const sol = paquete.solicitud
  if (!evaluacion.apta) {
    return { ok: false, error: `No se construye el payload: hay bloqueos (${evaluacion.bloqueos.map(etiqueta).join(", ")}).` }
  }
  const proveedor = buscarProveedor(sol, maestros.proveedores)
  const aprobacion = paquete.aprobacion
  if (!proveedor || !aprobacion) return { ok: false, error: "Falta proveedor o aprobación (no debería ocurrir con apta = true)." }

  const indicadorIva = sol.indicador_iva ?? evaluacion.derivados.indicador_iva
  const condicionPago = sol.condiciones_pago ?? evaluacion.derivados.condiciones_pago
  if (!indicadorIva || !condicionPago) return { ok: false, error: "Falta indicador de IVA o condición de pago." }

  const descripcion = truncarDescripcion(sol.descripcion)
  const unidad = derivarUnidad(paquete.cotizacion)
  const evidenciaSha = sha256(textoEvidencia(paquete.caso, aprobacion))

  const candidata = {
    referencia: { solicitud_id: sol.solicitud_id, correo_id: paquete.correo?.id ?? `${paquete.caso}-correo`, cotizacion_ref: paquete.cotizacion?.referencia ?? null },
    sociedad: "1000" as const,
    organizacion_compras: "1000" as const,
    proveedor: { codigo_sap: proveedor.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre },
    moneda: sol.moneda,
    condiciones_pago: condicionPago,
    aprobador: { email: aprobacion.de, fecha_aprobacion: aprobacion.fecha, evidencia_sha256: evidenciaSha },
    posiciones: [
      {
        numero: 10,
        descripcion,
        cantidad: sol.cantidad,
        unidad,
        precio_unitario: sol.valor_unitario,
        centro_costo: sol.centro_costo,
        subarea: sol.subarea,
        indicador_iva: indicadorIva,
      },
    ],
    excepciones: evaluacion.confirmaciones.map((c) => ({ codigo: etiqueta(c), detalle: c.detalle, confirmado_por: null })),
  }
  const validada = ordenCompraSchema.safeParse(candidata)
  if (!validada.success) return { ok: false, error: `El payload no cumple el esquema §7.4: ${validada.error.message}` }

  const de = (campo: string) => (evaluacion.derivados as Record<string, string>)[campo] !== undefined
  const trazabilidad: Trazabilidad = {
    "referencia.solicitud_id": { valor: sol.solicitud_id, fuente: "solicitud" },
    "referencia.correo_id": { valor: candidata.referencia.correo_id, fuente: paquete.correo ? "correo" : "derivado" },
    "referencia.cotizacion_ref": { valor: candidata.referencia.cotizacion_ref, fuente: "cotizacion" },
    sociedad: { valor: "1000", fuente: "constante", nota: "PRD §7.4" },
    organizacion_compras: { valor: "1000", fuente: "constante", nota: "PRD §7.4" },
    "proveedor.codigo_sap": { valor: proveedor.codigo_sap, fuente: "maestro.proveedores" },
    "proveedor.nit": { valor: proveedor.nit, fuente: "maestro.proveedores" },
    "proveedor.nombre": { valor: proveedor.nombre, fuente: "maestro.proveedores" },
    moneda: { valor: sol.moneda, fuente: "solicitud" },
    condiciones_pago: de("condiciones_pago")
      ? { valor: condicionPago, fuente: "maestro.proveedores", nota: "RC7: derivado de condiciones_pago_default" }
      : { valor: condicionPago, fuente: "solicitud" },
    "aprobador.email": { valor: aprobacion.de, fuente: "aprobacion" },
    "aprobador.fecha_aprobacion": { valor: aprobacion.fecha, fuente: "aprobacion", nota: `fecha en Bogotá ${fechaBogota(aprobacion.fecha)}` },
    "aprobador.evidencia_sha256": { valor: evidenciaSha, fuente: "derivado", nota: `sha256 de out/${paquete.caso}/aprobacion.txt` },
    "posiciones[0].numero": { valor: 10, fuente: "constante", nota: "A15: una posición" },
    "posiciones[0].descripcion": {
      valor: descripcion,
      fuente: "solicitud",
      ...(descripcion !== sol.descripcion ? { nota: `A14: truncada a 40 caracteres; original: "${sol.descripcion}"` } : {}),
    },
    "posiciones[0].cantidad": { valor: sol.cantidad, fuente: "solicitud" },
    "posiciones[0].unidad": { valor: unidad, fuente: "derivado", nota: `A13: desde el ítem de la cotización "${paquete.cotizacion?.items[0]?.descripcion ?? "(sin cotización)"}"` },
    "posiciones[0].precio_unitario": { valor: sol.valor_unitario, fuente: "solicitud", nota: "A12: IVA incluido, como en solicitud y cotización" },
    "posiciones[0].centro_costo": { valor: sol.centro_costo, fuente: "solicitud" },
    "posiciones[0].subarea": { valor: sol.subarea, fuente: "solicitud" },
    "posiciones[0].indicador_iva": de("indicador_iva")
      ? { valor: indicadorIva, fuente: "maestro.proveedores", nota: "RC6: derivado de indicador_iva_default; requiere confirmación" }
      : { valor: indicadorIva, fuente: "solicitud" },
    excepciones: { valor: candidata.excepciones.map((e) => e.codigo), fuente: "derivado", nota: "confirmaciones de oc_validar" },
  }
  return { ok: true, orden: validada.data, trazabilidad }
}

/** Huella del payload validado, sin `confirmado_por`: oc_crear la usa para detectar un payload alterado (PRD §10, riesgo). */
export function huellaPayload(orden: OrdenCompra): string {
  const sinConfirmacion = { ...orden, excepciones: orden.excepciones.map((e) => ({ codigo: e.codigo, detalle: e.detalle })) }
  return sha256(jsonCanonico(sinConfirmacion))
}

/** JSON con claves ordenadas: la huella no cambia si el modelo reordena las claves del objeto. */
function jsonCanonico(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(jsonCanonico).join(",")}]`
  if (valor && typeof valor === "object") {
    const entradas = Object.entries(valor as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entradas.map(([k, v]) => `${JSON.stringify(k)}:${jsonCanonico(v)}`).join(",")}}`
  }
  return JSON.stringify(valor)
}
