import type { CentroCosto, Maestros, Proveedor } from "../schemas/maestros.ts"
import type { Paquete } from "../schemas/paquete.ts"
import { aCentavos, fechaBogota, formatoCop, normalizarNit, normalizarNombre } from "../schemas/valores.ts"

// Reglas de control RC1–RC10 (PRD §7.3, spec/reglas.md). Funciones puras: misma entrada,
// mismo resultado. Montos comparados en centavos enteros; fechas como fecha de Bogotá.

export type Regla = "RC1" | "RC2" | "RC3" | "RC4" | "RC5" | "RC6" | "RC7" | "RC8" | "RC9" | "RC10"
export type Tipo = "bloqueo" | "confirmacion" | "derivado"

/** Resultado de una regla: { ok, codigo, detalle } más su tipo cuando no se cumple. */
export type ResultadoRegla = {
  regla: Regla
  ok: boolean
  tipo: Tipo | null
  codigo: string
  detalle: string
  valores?: Record<string, string | number>
}

const cumple = (regla: Regla, detalle: string): ResultadoRegla => ({ regla, ok: true, tipo: null, codigo: "OK", detalle })
const falla = (regla: Regla, tipo: Tipo, codigo: string, detalle: string, valores?: ResultadoRegla["valores"]): ResultadoRegla => ({
  regla,
  ok: false,
  tipo,
  codigo,
  detalle,
  ...(valores ? { valores } : {}),
})

// ---------- RC1 · proveedor ----------

export function buscarProveedor(sol: Paquete["solicitud"], proveedores: Proveedor[]): Proveedor | null {
  // A2: con NIT se busca solo por NIT; sin NIT, por nombre normalizado (A3).
  if (sol.proveedor_nit) return proveedores.find((p) => p.nit === normalizarNit(sol.proveedor_nit!)) ?? null
  return proveedores.find((p) => normalizarNombre(p.nombre) === normalizarNombre(sol.proveedor_nombre)) ?? null
}

export function rc1Proveedor(sol: Paquete["solicitud"], proveedor: Proveedor | null): ResultadoRegla {
  const criterio = sol.proveedor_nit ? `NIT ${normalizarNit(sol.proveedor_nit)}` : `nombre "${sol.proveedor_nombre}"`
  if (!proveedor) return falla("RC1", "bloqueo", "PROVEEDOR_NO_ENCONTRADO", `No existe en el maestro un proveedor con ${criterio}.`)
  if (!proveedor.activo) return falla("RC1", "bloqueo", "PROVEEDOR_INACTIVO", `${proveedor.nombre} (SAP ${proveedor.codigo_sap}) está inactivo.`)
  return cumple("RC1", `${proveedor.nombre} (SAP ${proveedor.codigo_sap}) encontrado por ${criterio} y activo.`)
}

// ---------- RC4 · centro de costo y subárea ----------

export function rc4Subarea(sol: Paquete["solicitud"], centro: CentroCosto | null): ResultadoRegla {
  if (!centro) return falla("RC4", "bloqueo", "CENTRO_COSTO_INEXISTENTE", `El centro de costo ${sol.centro_costo} no existe en el maestro.`)
  if (!centro.subareas.includes(sol.subarea.trim()))
    return falla("RC4", "bloqueo", "SUBAREA_NO_PERTENECE", `La subárea "${sol.subarea}" no pertenece a ${centro.centro_costo} (${centro.subareas.join(", ")}).`)
  return cumple("RC4", `"${sol.subarea}" pertenece a ${centro.centro_costo}.`)
}

// ---------- RC2 · aprobación ----------

export function rc2Aprobacion(aprobacion: Paquete["aprobacion"], centro: CentroCosto | null, centroCodigo: string): ResultadoRegla {
  if (!aprobacion) return falla("RC2", "bloqueo", "APROBACION_AUSENTE", "El paquete no trae el correo de aprobación del líder.")
  if (!aprobacion.aprobado) return falla("RC2", "bloqueo", "APROBACION_SIN_APROBADO", `El correo de ${aprobacion.de} no contiene "Aprobado".`)
  const autorizados = centro?.aprobadores.map((a) => a.email.toLowerCase()) ?? []
  if (!autorizados.includes(aprobacion.de))
    return falla(
      "RC2",
      "bloqueo",
      "APROBADOR_NO_AUTORIZADO",
      `${aprobacion.de} no está listado como aprobador de ${centroCodigo}${autorizados.length ? ` (autorizados: ${autorizados.join(", ")})` : ""}.`,
    )
  return cumple("RC2", `Aprobado por ${aprobacion.de}, aprobador de ${centroCodigo}.`)
}

// ---------- RC3 · tope del aprobador ----------

export function rc3Tope(sol: Paquete["solicitud"], aprobacion: Paquete["aprobacion"], centro: CentroCosto | null): ResultadoRegla | null {
  if (!aprobacion) return null // sin aprobación no hay a quién medir; RC2 ya bloquea
  const aprobador = centro?.aprobadores.find((a) => a.email.toLowerCase() === aprobacion.de)
  if (!aprobador) {
    const maxTope = Math.max(0, ...(centro?.aprobadores.map((a) => a.tope) ?? [0]))
    return falla(
      "RC3",
      "bloqueo",
      "APROBADOR_SIN_TOPE",
      `${aprobacion.de} no tiene tope en ${sol.centro_costo}.` +
        (centro && aprobacion && maxTope < sol.valor_total ? ` Ningún aprobador del centro alcanza ${formatoCop(sol.valor_total)} (tope máximo ${formatoCop(maxTope)}).` : ""),
    )
  }
  if (aCentavos(sol.valor_total) > aCentavos(aprobador.tope))
    return falla("RC3", "bloqueo", "MONTO_SUPERA_TOPE", `${formatoCop(sol.valor_total)} supera el tope de ${aprobador.email} (${formatoCop(aprobador.tope)}).`, {
      valor_total: sol.valor_total,
      tope: aprobador.tope,
    })
  return cumple("RC3", `${formatoCop(sol.valor_total)} ≤ tope de ${formatoCop(aprobador.tope)}.`)
}

// ---------- RC5 · cotización vs solicitud ----------

export function rc5Cotizacion(sol: Paquete["solicitud"], cotizacion: Paquete["cotizacion"]): ResultadoRegla {
  if (!cotizacion) return falla("RC5", "confirmacion", "COTIZACION_AUSENTE", "No hay cotización para contrastar el valor de la solicitud.")
  const s = aCentavos(sol.valor_total)
  const c = aCentavos(cotizacion.total)
  const diferencia = Math.abs(c - s)
  // En enteros: |c − s| / s ≤ 2 %  ⇔  |c − s| × 100 ≤ 2 × s
  const porcentaje = s === 0 ? "∞" : ((diferencia * 100) / s).toFixed(2)
  if (diferencia * 100 > 2 * s)
    return falla(
      "RC5",
      "confirmacion",
      "DIFERENCIA_COTIZACION",
      `La cotización (${formatoCop(cotizacion.total)}) difiere ${porcentaje} % de la solicitud (${formatoCop(sol.valor_total)}); el máximo es 2 %.`,
      { valor_solicitud: sol.valor_total, valor_cotizacion: cotizacion.total, diferencia_pct: Number(porcentaje) },
    )
  return cumple("RC5", `Cotización ${formatoCop(cotizacion.total)} vs solicitud ${formatoCop(sol.valor_total)} (${porcentaje} %).`)
}

// ---------- RC6 · indicador de IVA ----------

export function rc6IndicadorIva(sol: Paquete["solicitud"], proveedor: Proveedor | null, maestros: Maestros): { resultados: ResultadoRegla[]; indicador: string | null } {
  const informado = sol.indicador_iva
  const indicador = informado ?? proveedor?.indicador_iva_default ?? null
  const resultados: ResultadoRegla[] = []
  if (!informado && indicador)
    resultados.push(
      falla("RC6", "confirmacion", "IVA_DERIVADO", `La solicitud no informa indicador de IVA; se toma ${indicador} del proveedor (indicador_iva_default).`, {
        indicador_iva: indicador,
      }),
    )
  if (indicador && !maestros.indicadoresIva.some((i) => i.codigo === indicador))
    resultados.push(falla("RC6", "bloqueo", "IVA_INDICADOR_DESCONOCIDO", `El indicador de IVA ${indicador} no existe en el maestro.`))
  if (!indicador && proveedor) resultados.push(falla("RC6", "bloqueo", "IVA_INDICADOR_DESCONOCIDO", "No hay indicador de IVA informado ni derivable."))
  if (resultados.length === 0 && indicador) resultados.push(cumple("RC6", `Indicador de IVA ${indicador} informado en la solicitud.`))
  return { resultados, indicador }
}

// ---------- RC7 · condición de pago ----------

export function rc7CondicionPago(sol: Paquete["solicitud"], proveedor: Proveedor | null, maestros: Maestros): { resultados: ResultadoRegla[]; condicion: string | null } {
  const informada = sol.condiciones_pago
  const condicion = informada ?? proveedor?.condiciones_pago_default ?? null
  const resultados: ResultadoRegla[] = []
  if (!informada && condicion)
    resultados.push(
      falla("RC7", "derivado", "CONDICION_PAGO_DERIVADA", `La solicitud no informa condición de pago; se toma ${condicion} del proveedor (condiciones_pago_default).`, {
        condiciones_pago: condicion,
      }),
    )
  if (condicion && !maestros.condicionesPago.some((c) => c.codigo === condicion))
    resultados.push(falla("RC7", "bloqueo", "CONDICION_PAGO_DESCONOCIDA", `La condición de pago ${condicion} no existe en el maestro.`))
  if (resultados.length === 0 && condicion) resultados.push(cumple("RC7", `Condición de pago ${condicion} informada en la solicitud.`))
  return { resultados, condicion }
}

// ---------- RC8 · compra retroactiva ----------

export function rc8Retroactiva(sol: Paquete["solicitud"], factura: Paquete["factura"]): ResultadoRegla {
  if (!factura) return cumple("RC8", "No hay factura en el paquete.")
  if (factura.fecha < sol.fecha_solicitud)
    return falla(
      "RC8",
      "confirmacion",
      "COMPRA_RETROACTIVA",
      `La factura ${factura.numero} (${factura.fecha}) es anterior a la solicitud (${sol.fecha_solicitud}): compra retroactiva.`,
      { factura: factura.numero, fecha_factura: factura.fecha, fecha_solicitud: sol.fecha_solicitud },
    )
  return cumple("RC8", `La factura ${factura.numero} (${factura.fecha}) no es anterior a la solicitud.`)
}

// ---------- RC9 · fecha de aprobación ----------

export function rc9FechaAprobacion(sol: Paquete["solicitud"], aprobacion: Paquete["aprobacion"]): ResultadoRegla | null {
  if (!aprobacion) return null // RC2 ya bloquea
  const fechaAprob = fechaBogota(aprobacion.fecha)
  if (fechaAprob < sol.fecha_solicitud)
    return falla(
      "RC9",
      "confirmacion",
      "APROBACION_ANTERIOR_A_SOLICITUD",
      `La aprobación (${fechaAprob}) es anterior a la solicitud (${sol.fecha_solicitud}).`,
      { fecha_aprobacion: fechaAprob, fecha_solicitud: sol.fecha_solicitud },
    )
  return cumple("RC9", `Aprobación ${fechaAprob} ≥ solicitud ${sol.fecha_solicitud}.`)
}

// ---------- RC10 · cantidad × valor unitario ----------

export function rc10Total(sol: Paquete["solicitud"]): ResultadoRegla {
  const calculado = Math.round(sol.cantidad * aCentavos(sol.valor_unitario))
  const declarado = aCentavos(sol.valor_total)
  if (Math.abs(calculado - declarado) > 100) // ± 1 unidad monetaria = 100 centavos
    return falla(
      "RC10",
      "bloqueo",
      "TOTAL_INCONSISTENTE",
      `${sol.cantidad} × ${formatoCop(sol.valor_unitario)} = ${formatoCop(calculado / 100)}, distinto del valor_total ${formatoCop(sol.valor_total)}.`,
      { calculado: calculado / 100, valor_total: sol.valor_total },
    )
  return cumple("RC10", `${sol.cantidad} × ${formatoCop(sol.valor_unitario)} = ${formatoCop(sol.valor_total)}.`)
}

// ---------- Impuestos (A12, informativo) ----------

/** Desglose de un total con IVA incluido: base = round(total / (1 + tasa)) en centavos (mitad hacia arriba). */
export function calcularImpuestos(totalPesos: number, tasa: number): { total: number; base: number; iva: number; tasa: number } {
  const total = aCentavos(totalPesos)
  const base = Math.round(total / (1 + tasa))
  return { total: total / 100, base: base / 100, iva: (total - base) / 100, tasa }
}
