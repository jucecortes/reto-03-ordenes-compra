import { appendFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import type { Proveedor } from "../schemas/maestros.ts"
import { ordenCompraSchema, type OrdenCompra } from "../schemas/orden.ts"
import type { SapAdapter } from "./adapter.ts"

// SAP simulado sobre archivos (PRD HU-5): numeración secuencial desde 4500000001 y una línea JSON
// por OC en out/sap/ordenes.jsonl. El archivo es la fuente de verdad, así la numeración y la
// idempotencia sobreviven a reinicios del proceso.

export const PRIMER_NUMERO_OC = 4_500_000_001

type Registro = { numero_oc: string; fecha: string; solicitud_id: string; orden: OrdenCompra }

export class SapMock implements SapAdapter {
  private readonly archivo: string
  private cola: Promise<unknown> = Promise.resolve()

  constructor(
    directorioOut: string,
    private readonly proveedores: Proveedor[],
    private readonly ahora: () => Date = () => new Date(),
  ) {
    this.archivo = path.join(directorioOut, "sap", "ordenes.jsonl")
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const p = this.proveedores.find((x) => x.nit === nit)
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  /** Cumple la interfaz { numero_oc } y además informa la fecha de creación original. */
  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string; fecha: string } | null> {
    const r = (await this.leer()).find((o) => o.solicitud_id === solicitud_id)
    return r ? { numero_oc: r.numero_oc, fecha: r.fecha } : null
  }

  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    // Escrituras en serie: dos creaciones simultáneas no pueden tomar el mismo número.
    const tarea = this.cola.then(async () => {
      const valida = ordenCompraSchema.parse(orden)
      const previa = (await this.leer()).find((o) => o.solicitud_id === valida.referencia.solicitud_id)
      if (previa) return { numero_oc: previa.numero_oc, fecha: previa.fecha } // idempotencia también en "SAP"
      const registros = await this.leer()
      const numero_oc = String(PRIMER_NUMERO_OC + registros.length)
      const fecha = this.ahora().toISOString()
      const registro: Registro = { numero_oc, fecha, solicitud_id: valida.referencia.solicitud_id, orden: valida }
      await mkdir(path.dirname(this.archivo), { recursive: true })
      await appendFile(this.archivo, `${JSON.stringify(registro)}\n`, "utf-8")
      return { numero_oc, fecha }
    })
    this.cola = tarea.catch(() => undefined)
    return tarea
  }

  private async leer(): Promise<Registro[]> {
    try {
      const texto = await readFile(this.archivo, "utf-8")
      return texto
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Registro)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return []
      throw e
    }
  }
}
