import type { Maestros } from "../schemas/maestros.ts"
import type { Paquete } from "../schemas/paquete.ts"
import {
  buscarProveedor,
  calcularImpuestos,
  rc10Total,
  rc1Proveedor,
  rc2Aprobacion,
  rc3Tope,
  rc4Subarea,
  rc5Cotizacion,
  rc6IndicadorIva,
  rc7CondicionPago,
  rc8Retroactiva,
  rc9FechaAprobacion,
  type ResultadoRegla,
} from "./reglas.ts"

// Consolida RC1–RC10 en el resultado de oc_validar (PRD HU-2 y §6.2):
// { apta, bloqueos[], confirmaciones[], derivados, retroactiva } + detalle de cada control.

export type Hallazgo = { regla: string; codigo: string; detalle: string; valores?: ResultadoRegla["valores"] }

export type Evaluacion = {
  apta: boolean
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  /** Valores completados desde maestros que el agente debe informar (RC6, RC7). */
  derivados: { indicador_iva?: string; condiciones_pago?: string }
  retroactiva: boolean
  /** Resultado de cada regla evaluada, también las que cumplen: trazabilidad para la UI y auditoría. */
  controles: ResultadoRegla[]
  /** Desglose informativo del IVA sobre el total con IVA incluido (A12). Null si no hay indicador válido. */
  impuestos: ReturnType<typeof calcularImpuestos> | null
}

const aHallazgo = (r: ResultadoRegla): Hallazgo => ({ regla: r.regla, codigo: r.codigo, detalle: r.detalle, ...(r.valores ? { valores: r.valores } : {}) })

export function evaluar(paquete: Paquete, maestros: Maestros): Evaluacion {
  const sol = paquete.solicitud
  const proveedor = buscarProveedor(sol, maestros.proveedores)
  const centro = maestros.centrosCosto.find((c) => c.centro_costo === sol.centro_costo.trim()) ?? null
  const iva = rc6IndicadorIva(sol, proveedor, maestros)
  const pago = rc7CondicionPago(sol, proveedor, maestros)

  const controles = [
    rc1Proveedor(sol, proveedor),
    rc2Aprobacion(paquete.aprobacion, centro, sol.centro_costo),
    rc3Tope(sol, paquete.aprobacion, centro),
    rc4Subarea(sol, centro),
    rc5Cotizacion(sol, paquete.cotizacion),
    ...iva.resultados,
    ...pago.resultados,
    rc8Retroactiva(sol, paquete.factura),
    rc9FechaAprobacion(sol, paquete.aprobacion),
    rc10Total(sol),
  ].filter((r): r is ResultadoRegla => r !== null)

  const bloqueos = controles.filter((r) => r.tipo === "bloqueo").map(aHallazgo)
  const confirmaciones = controles.filter((r) => r.tipo === "confirmacion").map(aHallazgo)
  const derivados: Evaluacion["derivados"] = {}
  if (!sol.indicador_iva && iva.indicador) derivados.indicador_iva = iva.indicador
  if (!sol.condiciones_pago && pago.condicion) derivados.condiciones_pago = pago.condicion
  const tasa = maestros.indicadoresIva.find((i) => i.codigo === iva.indicador)?.tasa

  return {
    apta: bloqueos.length === 0,
    bloqueos,
    confirmaciones,
    derivados,
    retroactiva: controles.some((r) => r.codigo === "COMPRA_RETROACTIVA"),
    controles,
    impuestos: tasa === undefined ? null : calcularImpuestos(sol.valor_total, tasa),
  }
}

/** "RC5:DIFERENCIA_COTIZACION": formato compacto que usan el oráculo, el CSV de control y las excepciones. */
export const etiqueta = (h: Hallazgo) => `${h.regla}:${h.codigo}`
