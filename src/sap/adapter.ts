import type { OrdenCompra } from "../schemas/orden.ts"

// Interfaz obligatoria del adaptador SAP (PRD §7.4). Las herramientas solo conocen esta interfaz:
// el mock escribe en out/sap/; la implementación real (OData/BAPI) se diseña en SOLUCION.md §6.
export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null>
}
