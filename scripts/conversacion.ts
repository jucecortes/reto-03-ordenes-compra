// Fase 3 · DoD: conversación real contra el servidor en marcha (con ANTHROPIC_API_KEY).
// Prueba un caso aprobado (sol-001), uno rechazado (sol-002) y uno retroactivo con confirmación (sol-005).
// Uso: bun run scripts/conversacion.ts [url]   (por defecto http://localhost:8787)

const base = process.argv[2] ?? "http://localhost:8787"

type Respuesta = {
  sessionId: string
  reply: string
  needsConfirmation: boolean
  toolCalls: { nombre: string; ok: boolean; resumen: string; confirmacionAnulada?: boolean }[]
  avisos: { texto: string }[]
}

async function chat(message: string, sessionId?: string, confirmar?: boolean): Promise<Respuesta> {
  const r = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, ...(sessionId ? { sessionId } : {}), ...(confirmar === undefined ? {} : { confirmar }) }),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
  return r.json() as Promise<Respuesta>
}

function mostrar(titulo: string, r: Respuesta) {
  console.log(`\n── ${titulo}`)
  for (const t of r.toolCalls) console.log(`   ${t.ok ? "✔" : "✘"} ${t.nombre} → ${t.resumen}${t.confirmacionAnulada ? " (confirmado anulado por el backend)" : ""}`)
  for (const a of r.avisos) console.log(`   ⚠ ${a.texto}`)
  console.log(`   needsConfirmation=${r.needsConfirmation}`)
  console.log(`   Agente: ${r.reply.trim().split("\n").join("\n           ")}`)
}

const salud = await (await fetch(`${base}/api/health`)).json()
console.log("health:", JSON.stringify(salud))

const verificaciones: [boolean, string][] = []
const chequear = (cond: boolean, texto: string) => verificaciones.push([cond, texto])

const a = await chat("Procesa la solicitud sol-001.")
mostrar("sol-001 (aprobado)", a)
chequear(a.toolCalls.some((t) => t.nombre === "oc_crear" && t.ok) && !a.needsConfirmation, "sol-001: OC creada sin intervención")

const b = await chat("Procesa la solicitud sol-002.")
mostrar("sol-002 (rechazado)", b)
chequear(!b.toolCalls.some((t) => t.nombre === "oc_crear" && t.ok), "sol-002: no se crea OC")

const c1 = await chat("Procesa la solicitud sol-005. Muéstrame la OC y no la crees hasta que te confirme.")
mostrar("sol-005 (retroactivo) · turno 1", c1)
chequear(c1.needsConfirmation && !c1.toolCalls.some((t) => t.nombre === "oc_crear" && t.ok), "sol-005: pide confirmación y no crea en el primer turno")
const c2 = await chat("Confirmo, créala.", c1.sessionId, true)
mostrar("sol-005 · turno 2 (confirmo)", c2)
chequear(c2.toolCalls.some((t) => t.nombre === "oc_crear" && t.ok) && !c2.needsConfirmation, "sol-005: tras confirmar se crea la OC")

console.log("\n── Verificaciones")
for (const [ok, texto] of verificaciones) console.log(`   ${ok ? "✔" : "✘"} ${texto}`)
process.exit(verificaciones.every(([ok]) => ok) ? 0 : 1)
