# Reto 03 · Agente conversacional "Órdenes de Compra SAP"

Agente que lee el paquete de una solicitud de compra, lo valida contra los maestros (RC1–RC10), construye la OC con trazabilidad, genera la evidencia de aprobación y la crea en un SAP simulado, pidiendo confirmación humana para las excepciones.

- **Link para probar:** **URL_PUBLICA** (plan gratuito de Render: la primera visita puede tardar ~1 min en despertar el servicio). Sin clave de acceso.
- **Planteamiento de la solución:** [SOLUCION.md](SOLUCION.md) · **Especificación y oráculo:** [spec/reglas.md](spec/reglas.md)

## Levantar en local

Requisitos: [Bun](https://bun.sh) 1.4+ y una clave de Anthropic.

```bash
bun install
```

```bash
cp .env.example .env    # completar ANTHROPIC_API_KEY
```

```bash
bun run build && bun run dev
```

Abrir http://localhost:8787. Bun lee `.env` automáticamente. En Windows se puede evitar guardar la clave en un archivo: `$env:ANTHROPIC_API_KEY = Get-Secret -Name ANTHROPIC_API_KEY -AsPlainText; bun run dev` (PowerShell SecretStore).

Para desarrollar el front con recarga en caliente: `bun run dev` en una terminal y `bun x vite` en otra (http://localhost:5173, con proxy a la API).

### Variables de entorno

| Variable | Requerida | Por defecto | Uso |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Sí, para el chat | — | Clave del modelo. Solo en el backend: nunca en el front, el repositorio, los logs ni las respuestas |
| `LLM_MODEL` | No | `claude-haiku-5-5` | Modelo de Claude |
| `PORT` | No | `8787` | Puerto HTTP (Render lo inyecta) |
| `MAX_ITERACIONES` | No | `25` | Tope de iteraciones herramienta → modelo por turno |
| `MAX_TOKENS_SESION` | No | `300000` | Tope de tokens por sesión |
| `LLM_TIMEOUT_MS` | No | `60000` | Tiempo límite de cada llamada al modelo |
| `RATE_LIMIT` | No | `30` | Peticiones a `/api/chat` por IP cada 10 min |

## Verificación sin modelo (`demo.ts`)

```bash
bun install && bun run demo.ts
```

- **Qué hace:** limpia `out/` y procesa los 6 casos llamando directamente a las herramientas de `src/tools/oc.ts`. Por caso imprime `apta`, bloqueos, confirmaciones, `retroactiva` y número de OC o motivo.
- **Qué demuestra:** la idempotencia (sol-001 dos veces) y la confirmación explícita (sol-004, sol-005, sol-006).
- **Cómo verifica:** compara contra el oráculo de `spec/reglas.md` y termina con exit 1 si algo difiere. No necesita ninguna clave.

Otros comandos:

| Comando | Para qué |
|---|---|
| `bun test` | 67 pruebas: reglas, límites, herramientas, ciclo del agente, API y módulo |
| `bun run typecheck` | TypeScript estricto |
| `bun run cargar` | Valida maestros y casos con zod |
| `bun run scripts/conversacion.ts` | Conversación real contra el servidor en marcha: aprobado, rechazado y retroactivo con confirmación |
| `bun run scripts/empaquetar-modulo.ts` | Regenera `modulo/` desde las fuentes |

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message, confirmar? }` → `{ sessionId, reply, toolCalls[], needsConfirmation, confirmacion, avisos }`. Con `Accept: text/event-stream` responde un stream SSE de eventos: `sesion`, `texto`, `herramienta_inicio`, `herramienta_resultado`, `confirmacion_requerida`, `aviso`, `fin` |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión, más `pendiente` y `tokens` |
| `GET` | `/api/health` | `{ ok: true, provider, model, llmConfigurado }`, sin exponer claves |
| `GET` | `/api/casos` | Casos disponibles con su asunto (para la bandeja del chat) |

`confirmar: true | false` es lo que envían los botones Confirmar y Rechazar. Sin ese campo, el backend interpreta el texto ("confirmo", "sí, créala").

## Salidas (`out/`, generado en ejecución)

| Archivo | Contenido |
|---|---|
| `out/sap/ordenes.jsonl` | OC creadas en el SAP simulado (desde 4500000001) |
| `out/control.csv` | Un intento por fila: `solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts` |
| `out/log.jsonl` | Todas las llamadas a herramientas |
| `out/<caso>/trazabilidad.json` | Fuente de cada campo del payload |
| `out/<caso>/aprobacion.txt` | Evidencia de aprobación (su sha256 va en la OC) |

## Despliegue

- **Imagen:** `Dockerfile` basado en `oven/bun:1.4.4`. Instala, compila el front y arranca `bun src/server.ts`; un solo servicio sirve la API y el chat.
- **Render:** `render.yaml` define el Blueprint. `ANTHROPIC_API_KEY` se carga como secreto en el panel del servicio.

## Estructura

```
agent/prompt.md          comportamiento del agente      src/knowledge/   conocimiento del proceso
src/tools/oc.ts          herramientas oc_*              src/domain/      reglas RC1–RC10 y payload (puras)
src/agent/ciclo.ts       ciclo del agente               src/llm/         adaptador del proveedor
src/sap/                 interfaz SapAdapter + mock     src/schemas/     zod (§7.2, §7.4) y parsers
src/server.ts            API                            web/             chat React
demo.ts · tests/ · spec/ · modulo/ (bonus) · fixtures/ (entregados, sin modificar)
```
