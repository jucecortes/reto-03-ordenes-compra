import { useState } from "react"
import type { Item } from "../chat.ts"

type Herramienta = Extract<Item, { tipo: "herramienta" }>
type Confirmacion = Extract<Item, { tipo: "confirmacion" }>
type Control = { regla: string; ok: boolean; tipo: string | null; codigo: string; detalle: string }
type Validacion = { apta: boolean; retroactiva: boolean; controles: Control[]; derivados: Record<string, string> }

const ESTADO = { ejecutando: "●", ok: "✓", error: "✕" } as const

/** Tabla de controles de oc_validar: el resultado viene de la herramienta, no del texto del modelo. */
function Controles({ v }: { v: Validacion }) {
  const fallan = v.controles.filter((c) => !c.ok)
  return (
    <div className="validacion">
      <div className="validacion__cabecera">
        <span className={`insignia insignia--${v.apta ? (fallan.some((c) => c.tipo === "confirmacion") ? "aviso" : "ok") : "falla"}`}>
          {v.apta ? (fallan.some((c) => c.tipo === "confirmacion") ? "Apta con confirmación" : "Apta") : "Bloqueada"}
        </span>
        {v.retroactiva && <span className="insignia insignia--escala">Retroactiva</span>}
        <span className="tenue">
          {v.controles.filter((c) => c.ok).length} de {v.controles.length} controles cumplen
        </span>
      </div>
      {fallan.length > 0 && (
        <div className="tabla-contenedor">
          <table className="tabla tabla--controles">
            <thead>
              <tr>
                <th>Regla</th>
                <th>Resultado</th>
                <th>Detalle</th>
              </tr>
            </thead>
            <tbody>
              {fallan.map((c) => (
                <tr key={`${c.regla}${c.codigo}`}>
                  <td className="nowrap">
                    <strong>{c.regla}</strong>
                  </td>
                  <td>
                    <span className={`resultado resultado--${c.tipo === "bloqueo" ? "falla" : "aviso"}`}>
                      {c.tipo === "bloqueo" ? "Bloqueo" : c.tipo === "confirmacion" ? "Confirmación" : "Derivado"} · {c.codigo}
                    </span>
                  </td>
                  <td>{c.detalle}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export function TarjetaHerramienta({ h }: { h: Herramienta }) {
  const [abierta, setAbierta] = useState(false)
  const r = h.r
  const caso = typeof h.args === "object" && h.args && "caso" in h.args ? String((h.args as { caso: unknown }).caso) : ""
  return (
    <div className={`herramienta herramienta--${h.estado}`}>
      <button className="herramienta__cabecera" onClick={() => setAbierta(!abierta)} aria-expanded={abierta}>
        <span className="herramienta__icono">{ESTADO[h.estado]}</span>
        <span className="herramienta__nombre">{h.nombre}</span>
        {caso && <code className="herramienta__entrada">{caso}</code>}
        <span className="herramienta__meta">{r ? `${r.resumen} · ${r.ms} ms` : "ejecutando…"}</span>
        <span className="herramienta__flecha">{abierta ? "▾" : "▸"}</span>
      </button>
      {r?.confirmacionAnulada && (
        <p className="herramienta__error">El backend anuló confirmado=true: la analista aún no ha confirmado este caso.</p>
      )}
      {r && !r.ok && !r.confirmacionAnulada && <p className="herramienta__error">{(r.resultado as { error?: string }).error}</p>}
      {r?.ok && h.nombre === "oc_validar" && <Controles v={r.resultado as Validacion} />}
      {r?.ok && h.nombre === "oc_crear" && (
        <p className="oc-creada">
          OC <strong>{String((r.resultado as { numero_oc: string }).numero_oc)}</strong>
          {(r.resultado as { idempotente?: boolean }).idempotente ? " (ya existía: idempotente)" : " creada en SAP simulado"}
        </p>
      )}
      {r?.ok && r.descargas && (
        <p className="descargas">
          <span className="tenue">Evidencia:</span>
          {r.descargas.map((d) => (
            <a key={d.archivo} className="boton boton--enlace" href={d.url} download>
              ⤓ {d.archivo}
            </a>
          ))}
        </p>
      )}
      {abierta && (
        <div className="herramienta__detalle">
          <div>
            <span className="etiqueta">Argumentos</span>
            <pre>{JSON.stringify(h.args, null, 2)}</pre>
          </div>
          {r && (
            <div>
              <span className="etiqueta">Resultado</span>
              <pre>{JSON.stringify(r.resultado, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function TarjetaConfirmacion({ c, ocupado, alResponder }: { c: Confirmacion; ocupado: boolean; alResponder: (ok: boolean) => void }) {
  return (
    <section className={`confirmacion confirmacion--${c.estado === "pendiente" ? "pendiente" : c.estado}`} aria-label="Confirmación requerida">
      <header className="confirmacion__cabecera">
        <span className="confirmacion__titulo">Confirmación requerida · crear la OC de {c.caso}</span>
      </header>
      <ul className="confirmacion__observaciones">
        {c.confirmaciones.map((x) => (
          <li key={x.codigo}>
            <strong>{x.codigo}</strong>: {x.detalle}
          </li>
        ))}
      </ul>
      {c.estado === "pendiente" ? (
        <div className="confirmacion__acciones">
          <button className="boton boton--primario" disabled={ocupado} onClick={() => alResponder(true)}>
            Confirmar y crear OC
          </button>
          <button className="boton" disabled={ocupado} onClick={() => alResponder(false)}>
            Rechazar
          </button>
          <span className="tenue">Nada se crea en SAP hasta que confirmes.</span>
        </div>
      ) : (
        <p className="confirmacion__estado">{c.estado === "aprobada" ? "✓ Confirmada" : "✕ Rechazada: no se creó la OC"}</p>
      )}
    </section>
  )
}
