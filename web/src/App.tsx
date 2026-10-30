import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { useChat } from "./chat.ts"
import { TarjetaConfirmacion, TarjetaHerramienta } from "./componentes/Tarjetas.tsx"

type Salud = { ok: boolean; provider: string | null; model: string; llmConfigurado: boolean }
type Caso = { caso: string; solicitud_id: string | null; asunto: string | null; solicitante: string | null; tieneFactura: boolean }

const SUGERENCIAS = [
  "Procesa la solicitud sol-001",
  'Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.',
  "¿Por qué no se puede crear sol-003?",
]

export function App() {
  const { items, ocupado, pendiente, enviar, reiniciar } = useChat()
  const [salud, setSalud] = useState<Salud | null>(null)
  const [casos, setCasos] = useState<Caso[]>([])
  const [texto, setTexto] = useState("")
  const fin = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setSalud).catch(() => setSalud(null))
    fetch("/api/casos").then((r) => r.json()).then(setCasos).catch(() => setCasos([]))
  }, [])
  // Con llaves: scrollIntoView devuelve una promesa en navegadores recientes y React la tomaría como "cleanup".
  useEffect(() => {
    fin.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [items])

  const bloqueado = ocupado || salud?.llmConfigurado === false
  const mandar = (m: string, confirmar?: boolean) => {
    if (!m.trim() || bloqueado) return
    setTexto("")
    void enviar(m.trim(), confirmar)
  }
  const alEnviar = (e: FormEvent) => {
    e.preventDefault()
    mandar(texto)
  }
  const alTeclear = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      mandar(texto)
    }
  }

  return (
    <div className="app">
      <header className="cabecera">
        <div>
          <h1 className="cabecera__titulo">Órdenes de Compra SAP · Agente</h1>
          <p className="cabecera__subtitulo">Periferia IT Group · SAP simulado · Reto 03</p>
        </div>
        <div className="cabecera__acciones">
          {salud && (
            <span className={`estado-api ${salud.llmConfigurado ? "estado-api--ok" : "estado-api--falla"}`}>
              <span className="punto" aria-hidden="true" /> <span className="estado-api__texto">{salud.model}</span>
            </span>
          )}
          <button className="boton" onClick={reiniciar} disabled={ocupado}>
            Nueva conversación
          </button>
        </div>
      </header>

      <div className="cuerpo">
        <aside className="lateral">
          <h2 className="lateral__titulo">Solicitudes</h2>
          <ul className="lateral__lista">
            {casos.map((c) => (
              <li key={c.caso}>
                <button className="solicitud" disabled={bloqueado} onClick={() => mandar(`Procesa la solicitud ${c.caso}`)} title={`Procesar ${c.caso}`}>
                  <span className="solicitud__fila">
                    <strong>{c.caso}</strong>
                    <span className="tenue">{c.solicitud_id}</span>
                    {c.tieneFactura && <span className="insignia insignia--escala">Factura</span>}
                  </span>
                  <span className="solicitud__asunto">{c.asunto?.replace(/^Solicitud de orden de compra SOL-\d+ - /, "")}</span>
                  <span className="solicitud__meta tenue">{c.solicitante}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <main className="chat">
          <div className="chat__mensajes" aria-live="polite">
            {items.length === 0 && (
              <div className="bienvenida">
                <h2>¿Qué solicitud procesamos?</h2>
                <p className="tenue">
                  El agente lee el paquete, valida RC1–RC10 contra los maestros, construye la OC y solo la crea cuando las excepciones están confirmadas.
                </p>
                <div className="sugerencias">
                  {SUGERENCIAS.map((s) => (
                    <button key={s} className="sugerencia" onClick={() => mandar(s)} disabled={bloqueado}>
                      {s.length > 60 ? `${s.slice(0, 57)}…` : s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {items.map((i) => {
              switch (i.tipo) {
                case "usuario":
                  return (
                    <div key={i.clave} className="mensaje mensaje--usuario">
                      {i.texto}
                    </div>
                  )
                case "asistente":
                  return (
                    <div key={i.clave} className="mensaje mensaje--asistente">
                      <Markdown remarkPlugins={[remarkGfm]}>{i.texto}</Markdown>
                    </div>
                  )
                case "herramienta":
                  return <TarjetaHerramienta key={i.clave} h={i} />
                case "confirmacion":
                  return (
                    <TarjetaConfirmacion
                      key={i.clave}
                      c={i}
                      ocupado={ocupado}
                      alResponder={(ok) => mandar(ok ? `Confirmo, crea la OC de ${i.caso}.` : `No confirmo la OC de ${i.caso}.`, ok)}
                    />
                  )
                case "aviso":
                  return (
                    <div key={i.clave} className={`aviso aviso--${i.nivel}`}>
                      {i.texto}
                    </div>
                  )
              }
            })}
            {ocupado && <div className="escribiendo" aria-label="El agente está pensando" />}
            <div ref={fin} />
          </div>

          <form className="compositor" onSubmit={alEnviar}>
            <textarea
              className="compositor__texto"
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              onKeyDown={alTeclear}
              placeholder={pendiente ? `Confirma o rechaza la OC de ${pendiente.caso}, o escribe tu respuesta.` : "Escribe una instrucción o elige una solicitud."}
              disabled={bloqueado}
              rows={2}
              maxLength={4000}
              aria-label="Mensaje para el agente"
            />
            <button className="boton boton--primario" type="submit" disabled={bloqueado || !texto.trim()}>
              Enviar
            </button>
          </form>
        </main>
      </div>
    </div>
  )
}
