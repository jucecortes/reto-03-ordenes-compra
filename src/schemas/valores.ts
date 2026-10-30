// Utilidades de valores compartidas por parsers y dominio: dinero, fechas, NIT y nombres.

/** Pesos → centavos enteros. Todas las comparaciones de monto se hacen en centavos. */
export function aCentavos(pesos: number): number {
  return Math.round(pesos * 100)
}

/** "COP 11.400.000" | "11.400.000,50" → pesos (número). Punto = miles, coma = decimales. */
export function parsearPesos(texto: string): number {
  const limpio = texto.replace(/COP|\$|\s/gi, "").replace(/\./g, "").replace(",", ".")
  const valor = Number(limpio)
  if (!Number.isFinite(valor) || limpio === "") throw new Error(`monto ilegible: "${texto}"`)
  return valor
}

/** Formato para mostrar: 11400000 → "COP 11.400.000". */
export function formatoCop(pesos: number): string {
  return `COP ${pesos.toLocaleString("es-CO", { maximumFractionDigits: 2 })}`
}

/** Fecha calendario en America/Bogota de "YYYY-MM-DD" o de un ISO con hora. */
export function fechaBogota(valor: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) return valor
  const d = new Date(valor)
  if (Number.isNaN(d.getTime())) throw new Error(`fecha ilegible: "${valor}"`)
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(d)
}

/** Suma días a una fecha YYYY-MM-DD (aritmética en UTC, sin efectos de horario). */
export function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

/** "900.555.111-2" → "900555111": solo dígitos y sin el dígito de verificación tras el guion (A1). */
export function normalizarNit(nit: string): string {
  const sinDv = nit.includes("-") ? nit.slice(0, nit.lastIndexOf("-")) : nit
  return sinDv.replace(/\D/g, "")
}

/** "Papelería Central Ltda." → "papeleriacentralltda": minúsculas, sin tildes, solo letras y dígitos (A3). */
export function normalizarNombre(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
}
