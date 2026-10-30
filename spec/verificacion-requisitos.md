# Verificación de requisitos del PRD

Matriz requisito → implementación → evidencia. Cada fila se comprobó contra el código y las pruebas (`bun test`, 81 pruebas), no de memoria. Prioridades tal como las marca el PRD: **P0** obligatorio, **P1** sin calificativo, **P1 opcional** cuando el PRD lo dice literalmente.

## Historias de usuario (§5)

| Req. | Texto del PRD (resumido) | Implementación | Evidencia |
|---|---|---|---|
| HU-1 | `oc_leer_paquete` devuelve `{ correo, solicitud, cotizacion, aprobacion, factura? }` normalizados (§7.2) | `src/fixtures/lector.ts` · `src/tools/oc.ts` | `tests/fase1.test.ts` (sol-004, sol-005, sol-006) |
| HU-1 | Adjunto ausente → `null` con el nombre de lo que falta; sin excepción | `faltantes[]` en el paquete | `fase1`: "adjunto ausente → null con su nombre" |
| HU-2 | `oc_validar` aplica §7.3 y devuelve `{ apta, bloqueos[], confirmaciones[], derivados{} }` | `src/domain/reglas.ts`, `evaluar.ts` | `demo.ts` 6/6; `tests/fase2.test.ts` (límites de cada RC) |
| HU-2 | Bloqueos impiden; confirmaciones solo con `confirmado = true`; derivados se informan | `oc_crear` pasos 1 y 4; prompt | `fase2` y `fase3`: pendiente → confirmado |
| HU-3 | `oc_construir_payload` produce §7.4 válido con zod | `src/domain/payload.ts`, `src/schemas/orden.ts` | `fase2`: payload |
| HU-3 | Cada valor trazable a `solicitud`, `cotizacion`, `maestro.<nombre>` o `derivado`, en `out/<caso>/trazabilidad.json` | `Fuente` limitada a esos cuatro valores | `tests/requisitos.test.ts` (HU-3) |
| HU-4 **P0** | `aprobacion.txt` con encabezados (de, para, fecha, asunto), cuerpo y sha256 del contenido | `src/domain/evidencia.ts` | `requisitos`: encabezados y línea sha256 verificada |
| HU-4 **P1** | `aprobacion.pdf` con el mismo contenido (`pdf-lib` o similar) | `archivoEvidenciaPdf` (pdf-lib, reproducible) | `requisitos`: `%PDF-` y bytes idénticos entre ejecuciones |
| HU-4 (extra) | Descarga de la evidencia desde el chat con control de acceso | `GET /api/sessions/:id/evidencias/:caso/:archivo`: lista blanca de archivos, solo la sesión que la generó | `fase3`: 200 para la dueña, 403 para otra sesión, 404 fuera de la lista |
| HU-5 | `oc_crear` solo si `apta` y (sin confirmaciones o `confirmado`) | `src/tools/oc.ts` + backend (`src/agent/ciclo.ts`) | `fase2`, `fase3` |
| HU-5 | Número secuencial desde 4500000001, `out/sap/ordenes.jsonl`, devuelve `{ numero_oc, fecha }` | `src/sap/mock.ts` | `demo.ts`: 4500000001–4500000004 |
| HU-5 | La misma `solicitud_id` dos veces → número existente (idempotencia) | `buscarOrdenPorReferencia` | `demo.ts`; `requisitos`: misma fecha y número; `nota` aclara que es la fecha original |
| HU-5 | Cada intento (creada, bloqueada o pendiente) → fila en `out/control.csv` con las 7 columnas | `registrarControl` | `demo.ts`: 10 intentos registrados |
| HU-6 | Paquete incompleto, JSON malformado, monto no numérico → `{ ok: false, error }` legible | lector + `definir()` (nunca lanza) | `fase1` y `fase2` |

## Arquitectura (§6)

| Req. | Texto del PRD | Implementación | Evidencia |
|---|---|---|---|
| §6.1 | Front: historial, entrada, "pensando", cada tool call (nombre, argumentos, resultado resumido), confirmación resaltada | `web/` | Prueba en navegador (prompt §11, sol-004) |
| §6.1 | Backend con ciclo, tope de iteraciones y sesión | `src/agent/ciclo.ts` | `fase3` |
| §6.1 | Herramientas zod, separadas del servidor, importables desde `demo.ts`; única fuente de valores | `src/tools/oc.ts` | `demo.ts` sin servidor |
| §6.1 | Adaptador LLM `enviar(mensajes, herramientas)`; cambiar de proveedor no toca el ciclo | `src/llm/adapter.ts`, `anthropic.ts` | `fase3`: ciclo con modelo guionado |
| §6.1 | System prompt en `agent/prompt.md` | `agent/prompt.md` | — |
| §6.2 | `{ description, args (zod con .describe()), execute → string }`, nunca lanza; nombre `oc_<export>` | `definir()` | `fase2`: argumentos inválidos y herramienta desconocida |
| §6.2 | `oc_leer_excel { ruta } → { filas[] }` (**P1 opcional**) | `src/fixtures/excel.ts` | `requisitos`: 6 filas validadas y 5 rutas rechazadas |
| §6.3 CA1 | Tope de iteraciones (25); al alcanzarlo responde con lo que tiene | `MAX_ITERACIONES` | `fase3` CA1 |
| §6.3 CA2 | El modelo no afirma valores que no salgan de herramientas | Prompt + huella del payload en `oc_crear` | `fase2`: payload alterado rechazado |
| §6.3 CA3 | Confirmación humana: pregunta al cerrar el turno; solo procede si el siguiente mensaje confirma; el front lo resalta | Prompt + validación por turno en el backend + tarjeta | `fase3`: `confirmado` anulado y "confirmo" |
| §6.3 CA4 | Cada llamada en el historial visible y en `out/log.jsonl` | `registrarLlamada` + historial de sesión | `fase2`: log |
| §6.3 CA5 | Error de herramienta o de LLM en lenguaje claro; la sesión no muere | `turno()` try/catch | `fase3` CA5 |
| §6.4 | `POST /api/chat`, `GET /api/sessions/:id`, `GET /api/health` sin claves | `src/server.ts` | `fase3`: API |
| §6.5 | Comportamiento / conocimiento / ejecución separados | `agent/`, `src/knowledge/`, `src/tools/` | — |
| §6.6 | `demo.ts`: 6 casos, `apta`, bloqueos, confirmaciones, `retroactiva`, OC o motivo; sol-001 dos veces; confirmación de sol-004; sin clave | `demo.ts` | `bun install && bun run demo.ts` → 6/6 (también desde el ZIP) |

## Requisitos funcionales (§7) y no funcionales (§8)

| Req. | Texto del PRD | Evidencia |
|---|---|---|
| §7.2 | Forma del paquete normalizado | `src/schemas/paquete.ts` |
| §7.3 | RC1–RC10 | `spec/reglas.md` + `fase2` + `demo.ts` |
| §7.4 | Payload validado con zod; interfaz `SapAdapter` en `src/sap/adapter.ts`; `mock.ts` sobre `out/sap/` | `src/sap/` |
| §7.5 | Diseño del adaptador SAP real | `SOLUCION.md` §6 |
| §8 Arranque | Un comando levanta front y backend (`bun run dev`) en menos de 2 min | `bun run dev` = `vite build` + servidor |
| §8 Determinismo | `demo.ts` igual entre ejecuciones; `out/` se limpia al inicio | Dos ejecuciones idénticas |
| §8 Seguridad | Clave solo en el backend; sin datos reales; herramientas sin shell | `/api/health` sin clave; secreto en Render |
| §8 Costo | Topes de iteraciones y de tokens por sesión configurables | `MAX_ITERACIONES`, `MAX_TOKENS_SESION` (+ límite por IP) |
| §8 Robustez | Errores tipados, tiempo límite del LLM con mensaje claro, un caso malo no frena otros | `LLM_TIMEOUT_MS`; `fase3` CA5 |
| §8 Legibilidad | TypeScript sin `any` | `grep` sin resultados; `tsc` estricto |
| §8 Dependencias | Justificadas en `SOLUCION.md` | `SOLUCION.md` §8, tabla de dependencias |

## Entregables (§9)

| Req. | Evidencia |
|---|---|
| §9.1 `SOLUCION.md` con 12 secciones | `SOLUCION.md` §1–§12 |
| §9.2 README (un comando, variables, demo, link, clave de acceso si aplica) | `README.md` |
| §9.3 Link activo | https://reto03-ordenes-compra-jqlg.onrender.com |
| §9.4 Bonus `modulo/` con las mismas piezas | `tests/modulo.test.ts` |
| §9.5 Repositorio con historial o `reto-03-<apellido>.zip` sin `node_modules/`, `out/` ni `.env` | GitHub `jucecortes/reto-03-ordenes-compra` · `reto-03-cortes.zip` |
