/**
 * ¿El cuerpo de la aprobación contiene "Aprobado"? (RC2, A4)
 * Palabra completa, sin distinguir mayúsculas ni tildes. "No aprobado" no cuenta como aprobación.
 */
export function contieneAprobado(cuerpo: string): boolean {
  const t = cuerpo.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  if (/\bno\s+(esta\s+)?aprobad[oa]\b/.test(t)) return false
  return /\baprobad[oa]\b/.test(t)
}
