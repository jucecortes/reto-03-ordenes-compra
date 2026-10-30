# Especificación de reglas — Reto 03 "Órdenes de Compra SAP"

Fuente de verdad: [`PRD.md`](../PRD.md), en particular la sección 7.3 (reglas de control) y la sección 3.1 (objetivos por caso). Este documento traduce cada regla a una condición verificable y fija el resultado esperado de cada caso **antes** de escribir código. `demo.ts` lee el bloque JSON de la sección (b) y falla (exit 1) si algún caso difiere.

Convenciones:

- **Montos** en centavos enteros (`COP 11.400.000` → `1_140_000_000`). Las comparaciones de monto se hacen con enteros, sin divisiones flotantes.
- **Fechas** como fecha calendario `YYYY-MM-DD` en zona `America/Bogota`. Un ISO con hora (`2026-08-21T10:02:00-05:00`) se convierte a su fecha en Bogotá antes de comparar.
- **Tipos** (PRD §7.3): **Bloqueo** impide crear la OC. **Confirmación** la permite solo con `confirmado = true`. **Derivado** completa un valor desde un maestro y se informa.
- `apta = (bloqueos.length === 0)`. La OC se crea si `apta` y (`confirmaciones` vacío **o** `confirmado = true`) (HU-5).

## (a) Tabla de reglas

| ID | Regla del PRD (§7.3) | Condición evaluada | Resultado si no se cumple | Código de motivo |
|---|---|---|---|---|
| RC1 | El proveedor debe existir en `proveedores.json` (por NIT; si no hay NIT, por nombre normalizado) y estar `activo`. | Si `solicitud.proveedor_nit` existe: NIT normalizado (solo dígitos, sin DV) = `maestro.nit`. Si no existe: `normalizar(proveedor_nombre)` = `normalizar(maestro.nombre)`. Luego `activo === true`. | Bloqueo | `PROVEEDOR_NO_ENCONTRADO` · `PROVEEDOR_INACTIVO` |
| RC2 | La aprobación debe existir, contener "Aprobado" y venir de un correo listado como aprobador del `centro_costo`. | `aprobacion ≠ null` ∧ el cuerpo contiene la palabra "aprobado" (sin distinguir mayúsculas) y no "no aprobado" ∧ `aprobacion.de` (minúsculas) ∈ `centro.aprobadores[].email`. | Bloqueo | `APROBACION_AUSENTE` · `APROBACION_SIN_APROBADO` · `APROBADOR_NO_AUTORIZADO` |
| RC3 | `valor_total` ≤ `tope` del aprobador para ese centro. | Se toma el aprobador del centro cuyo email = `aprobacion.de`. `valor_total` ≤ `tope` (ambos en centavos, igualdad permitida). Si el remitente no es aprobador del centro, no tiene tope en él. | Bloqueo | `MONTO_SUPERA_TOPE` · `APROBADOR_SIN_TOPE` |
| RC4 | `subarea` debe pertenecer al `centro_costo`. | El centro existe en el maestro ∧ `subarea` ∈ `centro.subareas` (comparación exacta tras recortar espacios). | Bloqueo | `CENTRO_COSTO_INEXISTENTE` · `SUBAREA_NO_PERTENECE` |
| RC5 | `abs(cotizacion.total − solicitud.valor_total) / solicitud.valor_total` ≤ 2 %. Si excede: confirmación con ambos valores. Si no hay cotización: confirmación. | En enteros: `abs(c − s) × 100 ≤ 2 × s`. | Confirmación (con ambos valores y el %) | `DIFERENCIA_COTIZACION` · `COTIZACION_AUSENTE` |
| RC6 | `indicador_iva` ausente → se deriva del proveedor (`indicador_iva_default`) y se pide confirmación. | Si falta `solicitud.indicador_iva`: derivado = `proveedor.indicador_iva_default`, más una confirmación. | Confirmación + derivado | `IVA_DERIVADO` |
| RC7 | `condiciones_pago` ausente → se deriva del proveedor. Solo se informa. | Si falta `solicitud.condiciones_pago`: derivado = `proveedor.condiciones_pago_default`. | Derivado (no bloquea ni pide confirmación) | `CONDICION_PAGO_DERIVADA` |
| RC8 | Existe `factura` con `fecha` < `fecha_solicitud` → `retroactiva = true`. Confirmación. Se registra en control. | `factura ≠ null` ∧ `fecha(factura) < fecha_solicitud` (estricto). | Confirmación; `retroactiva = true` en la salida y en `out/control.csv` | `COMPRA_RETROACTIVA` |
| RC9 | La fecha de aprobación debe ser ≥ `fecha_solicitud`. Si no: confirmación. | `fecha_bogota(aprobacion.fecha) ≥ fecha_solicitud` (el mismo día cumple). | Confirmación | `APROBACION_ANTERIOR_A_SOLICITUD` |
| RC10 | `cantidad × valor_unitario` debe igualar `valor_total` (± 1 unidad monetaria). Si no: bloqueo. | En centavos: `abs(cantidad × valor_unitario − valor_total) ≤ 100`. | Bloqueo | `TOTAL_INCONSISTENTE` |

Códigos de soporte para valores que no permiten evaluar una regla (HU-6, ver ambigüedades A10 y A11):

| Código | Cuándo | Tipo |
|---|---|---|
| `IVA_INDICADOR_DESCONOCIDO` | El `indicador_iva` informado o derivado no existe en `indicadores-iva.json`. | Bloqueo (no se puede construir la posición) |
| `CONDICION_PAGO_DESCONOCIDA` | La `condiciones_pago` informada o derivada no existe en `condiciones-pago.json`. | Bloqueo |

## (b) Resultado esperado por caso

### sol-001 — Licencias antivirus (flujo normal, O1)

- **RC1:** NIT 900555111 = TecnoSuministros S.A.S., `activo`. ✔
- **RC2:** `mlopez@` está listado en CC-1010 y el cuerpo dice "Aprobado". ✔
- **RC3:** COP 11.400.000 ≤ tope de 50.000.000. ✔
- **RC4:** Infraestructura ∈ CC-1010. ✔
- **RC5:** cotización 11.400.000 = solicitud (0 %). ✔
- **RC6/RC7:** C1 y Z030 vienen informados. ✔
- **RC8:** no hay factura. ✔
- **RC9:** aprobación 2026-08-21 ≥ solicitud 2026-08-20. ✔
- **RC10:** 120 × 95.000 = 11.400.000. ✔
- **Decisión:** apta, sin confirmaciones → **OC creada sin intervención humana**. Una segunda ejecución devuelve el mismo número (`idempotente = true`).

### sol-002 — Proveedor inexistente (O2)

- **RC1:** el NIT 901999000 no está en el maestro → **Bloqueo `PROVEEDOR_NO_ENCONTRADO`**. Como el NIT viene informado, no se busca por nombre (ver A2); el nombre "Soluciones Digitales del Norte S.A.S." tampoco existe.
- El resto de reglas cumple: `mlopez@` es aprobadora de CC-1010, 8.500.000 ≤ 50.000.000, Desarrollo ∈ CC-1010, 0 %, 5 × 1.700.000 = 8.500.000, 08-22 ≥ 08-22.
- **Decisión:** no apta, **sin OC**. Acción: pedir el alta del proveedor en el maestro (SAP) o corregir el NIT.

### sol-003 — Aprobador sin autoridad (O2)

- **RC2:** `fvargas@` aprueba, pero solo está listado en CC-3030 (Comercial), no en CC-2020 → **Bloqueo `APROBADOR_NO_AUTORIZADO`**.
- **RC3:** `fvargas@` no tiene tope en CC-2020 → **Bloqueo `APROBADOR_SIN_TOPE`**. Además, ningún aprobador de CC-2020 alcanza los 74.000.000 (el tope de `rtorres@` es 30.000.000).
- El resto cumple: proveedor activo, Servicios Generales ∈ CC-2020, 0 %, 40 × 1.850.000 = 74.000.000, 08-25 ≥ 08-24.
- El cuerpo dice "Aprobado desde comercial…": es un dato del documento, no una autorización (ver A9).
- **Decisión:** no apta, **sin OC**. Acción: aprobación de un aprobador de CC-2020 con tope suficiente; hoy no existe ninguno, así que hay que escalar o reasignar el centro de costo.

### sol-004 — Cotización distinta de la solicitud (O3)

- **RC5:** cotización 26.500.000 vs solicitud 25.000.000 → 6,00 % > 2 % → **Confirmación `DIFERENCIA_COTIZACION`**, con ambos valores.
- El resto cumple: Cloud Andina activo, `dgarcia@` en CC-1010 con tope 200.000.000, Desarrollo ∈ CC-1010, 100 × 250.000 = 25.000.000, aprobación del mismo día (08-26 ≥ 08-26).
- **Decisión:** apta con confirmación → **OC solo tras `confirmado = true`**. Sin confirmación, el resultado es pendiente.

### sol-005 — Compra retroactiva (O4)

- **RC8:** factura FC-88231 del 2026-08-10 < solicitud 2026-08-27 → **Confirmación `COMPRA_RETROACTIVA`**, con `retroactiva = true`.
- El resto cumple: Papelería Central activo, `rtorres@` en CC-2020 con tope 30.000.000 ≥ 3.200.000, Compras ∈ CC-2020, 0 %, 1 × 3.200.000, 08-28 ≥ 08-27.
- El cuerpo pide "crear la OC para poder radicarla": es un dato, no una instrucción (ver A9).
- **Decisión:** apta con confirmación → **OC solo tras `confirmado = true`**, marcada `retroactiva = true` en `out/control.csv`.

### sol-006 — IVA no informado (O3)

- **RC1:** no hay NIT; se busca por nombre normalizado "TecnoSuministros S.A.S." → existe y está activo. ✔
- **RC6:** sin `indicador_iva` → derivado **C1** desde el proveedor → **Confirmación `IVA_DERIVADO`**.
- **RC7:** sin `condiciones_pago` → derivado **Z030** desde el proveedor (solo se informa).
- El resto cumple: `mlopez@` en CC-1010 con tope 50.000.000 ≥ 5.400.000, Soporte ∈ CC-1010, 0 %, 30 × 180.000 = 5.400.000, 08-29 ≥ 08-29.
- **Decisión:** apta con confirmación → **OC solo tras `confirmado = true`**.

### Resumen y oráculo de `demo.ts`

| Caso | apta | Bloqueos | Confirmaciones | Derivados | retroactiva | OC |
|---|---|---|---|---|---|---|
| sol-001 | ✔ | — | — | — | no | sí, directa (e idempotente al repetir) |
| sol-002 | ✘ | RC1 `PROVEEDOR_NO_ENCONTRADO` | — | — | no | no |
| sol-003 | ✘ | RC2 `APROBADOR_NO_AUTORIZADO`, RC3 `APROBADOR_SIN_TOPE` | — | — | no | no |
| sol-004 | ✔ | — | RC5 `DIFERENCIA_COTIZACION` | — | no | solo con confirmación |
| sol-005 | ✔ | — | RC8 `COMPRA_RETROACTIVA` | — | **sí** | solo con confirmación |
| sol-006 | ✔ | — | RC6 `IVA_DERIVADO` | `indicador_iva = C1`, `condiciones_pago = Z030` | no | solo con confirmación |

<!-- oraculo:inicio — demo.ts lee este bloque; no cambiar su formato -->
```json
{
  "sol-001": { "apta": true,  "bloqueos": [], "confirmaciones": [], "derivados": {}, "retroactiva": false, "crea_sin_confirmar": true },
  "sol-002": { "apta": false, "bloqueos": ["RC1:PROVEEDOR_NO_ENCONTRADO"], "confirmaciones": [], "derivados": {}, "retroactiva": false, "crea_sin_confirmar": false },
  "sol-003": { "apta": false, "bloqueos": ["RC2:APROBADOR_NO_AUTORIZADO", "RC3:APROBADOR_SIN_TOPE"], "confirmaciones": [], "derivados": {}, "retroactiva": false, "crea_sin_confirmar": false },
  "sol-004": { "apta": true,  "bloqueos": [], "confirmaciones": ["RC5:DIFERENCIA_COTIZACION"], "derivados": {}, "retroactiva": false, "crea_sin_confirmar": false },
  "sol-005": { "apta": true,  "bloqueos": [], "confirmaciones": ["RC8:COMPRA_RETROACTIVA"], "derivados": {}, "retroactiva": true, "crea_sin_confirmar": false },
  "sol-006": { "apta": true,  "bloqueos": [], "confirmaciones": ["RC6:IVA_DERIVADO"], "derivados": { "indicador_iva": "C1", "condiciones_pago": "Z030" }, "retroactiva": false, "crea_sin_confirmar": false }
}
```
<!-- oraculo:fin -->

Secuencia de la demo (PRD §6.6):

1. Limpiar `out/`.
2. Procesar los 6 casos sin confirmar.
3. Repetir sol-001 para mostrar la idempotencia.
4. Confirmar explícitamente sol-004, sol-005 y sol-006.

OC esperadas: sol-001 → 4500000001, sol-004 → 4500000002, sol-005 → 4500000003, sol-006 → 4500000004.

## (c) Ambigüedades del PRD e interpretación elegida

Criterio: la interpretación más conservadora, es decir, la que nunca crea una OC que una lectura estricta no permitiría. Todas se trasladan a `SOLUCION.md` > "Supuestos".

| # | Ambigüedad | Interpretación elegida |
|---|---|---|
| A1 | RC1 con NIT en formatos distintos (`900.555.111-2` en la cotización, `900555111` en el maestro). | Se normaliza a solo dígitos y se descarta el dígito de verificación si viene tras un guion. RC1 usa el NIT de la **solicitud**; el de la cotización solo se reporta en el paquete. |
| A2 | RC1: si el NIT viene informado pero no existe, ¿se busca también por nombre? | **No.** El PRD dice "por NIT; si no hay NIT, por nombre". Un NIT inexistente bloquea, aunque el nombre coincidiera. |
| A3 | "Nombre normalizado" no está definido. | Minúsculas, sin tildes (NFD), solo letras y dígitos; se conservan las siglas societarias ("S.A.S." → "sas"). Coincidencia exacta tras normalizar, sin coincidencias aproximadas. |
| A4 | RC2 "contener 'Aprobado'". | La palabra completa "aprobado", sin distinguir mayúsculas. Si aparece como "no aprobado", **no** cuenta como aprobación. |
| A5 | RC3 cuando el remitente no es aprobador del centro. | No tiene tope en ese centro → también se bloquea (`APROBADOR_SIN_TOPE`). Se reportan RC2 y RC3 para que la acción sugerida sea completa. |
| A6 | RC3, RC5 y RC10: ¿`valor_total` incluye IVA? | Sí. Las cotizaciones muestran precio unitario "IVA incl." igual al `valor_unitario` de la solicitud, y el total "IVA incluido" igual al `valor_total`. Los topes y la comparación del 2 % usan totales con IVA. |
| A7 | Igualdades en los límites. | RC3: tope exacto **cumple** (≤). RC5: exactamente 2 % **cumple** (≤). RC10: diferencia de exactamente 1 COP **cumple**. RC9: el mismo día **cumple** (≥). RC8: factura del mismo día de la solicitud **no** es retroactiva (< estricto). |
| A8 | RC8 frente al prompt de trabajo, que menciona "anterior a solicitud/aprobación". | Gana el PRD: solo se compara con `fecha_solicitud`. |
| A9 | Textos de correos y aprobaciones con instrucciones ("crear la OC para poder radicarla", "Aprobado desde comercial"). | Son datos no confiables. Nunca se ejecutan ni cambian el resultado de una regla. |
| A10 | Un `indicador_iva` o `condiciones_pago` que no existe en el maestro (no ocurre en los fixtures). | Bloqueo con código propio (`IVA_INDICADOR_DESCONOCIDO` / `CONDICION_PAGO_DESCONOCIDA`): no se puede construir un payload válido. Es el único agregado a §7.3, y existe para cumplir HU-6 sin crear OC con códigos inválidos. |
| A11 | Paquete incompleto o JSON malformado (HU-6). | `oc_leer_paquete` reporta el adjunto faltante como `null` con su nombre. Si falta `solicitud.json`, `{ ok: false, error }`. La aprobación ausente se evalúa como RC2 (bloqueo) y la cotización ausente como RC5 (confirmación). |
| A12 | `precio_unitario` del payload: ¿con o sin IVA? | Se conserva el `valor_unitario` de la solicitud (IVA incluido, trazable a `solicitud`). El desglose base/IVA se calcula en `derivados.impuestos` (informativo), con la tasa del indicador: `base = round(total / (1 + tasa))` en centavos, redondeo mitad hacia arriba, e `iva = total − base`. |
| A13 | `unidad` (`UN` / `H` / `MES`) no viene en la solicitud. | Derivado de la cotización: `H` si el ítem cotizado se vende por hora (el texto del ítem empieza por "Hora"); en cualquier otro caso `UN`. Se marca como `derivado` en la trazabilidad. |
| A14 | `descripcion` máx. 40 caracteres en el payload. | Se trunca la descripción de la solicitud a 40 caracteres (sin cortar a mitad de una palabra si es posible). El texto completo queda en la trazabilidad. |
| A15 | Posiciones. | La solicitud tiene una sola línea: una posición, número 10. |
| A16 | `excepciones[].confirmado_por` sin autenticación. | `"analista (sesión <id>)"` cuando se confirma desde el chat; `"demo.ts"` en la demo; `null` si aún no se ha confirmado. |
| A17 | `cotizacion.validez_hasta`. | `fecha de la cotización + N días` de "Validez de la oferta". Solo se informa: el PRD no define una regla de vencimiento y no se inventa. |
| A18 | Confirmación humana (CA3) frente al prompt de trabajo (token del backend). | Se cumplen ambos. El agente cierra el turno con la pregunta. El backend solo pasa `confirmado = true` a `oc_crear` si el analista confirmó en ese turno (botón o mensaje afirmativo) y existe una confirmación pendiente para ese caso. Un `confirmado = true` enviado por el modelo sin confirmación del humano se ignora. |
