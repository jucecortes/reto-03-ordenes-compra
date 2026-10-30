# Conocimiento del proceso: órdenes de compra

Este documento lo consulta el agente (se agrega al system prompt). Describe el proceso y qué significa cada resultado. Las reglas se **ejecutan** en `src/tools/` y `src/domain/`; aquí solo se explican.

## Proceso

1. El **solicitante** envía por correo el Excel de solicitud, la cotización del proveedor y el correo de aprobación de su líder.
2. La **analista administrativa** pide al agente procesar el caso.
3. El agente lee el paquete, lo valida contra los maestros (proveedores, centros de costo y aprobadores, indicadores de IVA, condiciones de pago), construye la OC, genera la evidencia de aprobación y la crea en SAP.
4. **Contabilidad y auditoría** consultan `out/control.csv`: una fila por cada intento de creación (creada, idempotente, bloqueada, pendiente de confirmación, rechazada).

## Reglas de control (PRD §7.3)

| Regla | Qué verifica | Si falla |
|---|---|---|
| RC1 | El proveedor existe (por NIT; si no hay NIT, por nombre) y está activo | Bloqueo |
| RC2 | Hay aprobación, dice "Aprobado" y la envía un aprobador del centro de costo | Bloqueo |
| RC3 | El valor total no supera el tope del aprobador en ese centro | Bloqueo |
| RC4 | La subárea pertenece al centro de costo | Bloqueo |
| RC5 | La cotización no difiere más de 2 % de la solicitud (o falta la cotización) | Confirmación |
| RC6 | Falta el indicador de IVA: se toma el del proveedor | Confirmación + derivado |
| RC7 | Falta la condición de pago: se toma la del proveedor | Derivado (solo se informa) |
| RC8 | Hay una factura anterior a la solicitud: compra retroactiva | Confirmación + marca en control |
| RC9 | La aprobación es anterior a la solicitud | Confirmación |
| RC10 | Cantidad × valor unitario = valor total (± 1 peso) | Bloqueo |

Los valores totales incluyen IVA, igual que en la solicitud y la cotización.

## Códigos y acción sugerida

| Código | Significado | Acción sugerida a la analista |
|---|---|---|
| `RC1:PROVEEDOR_NO_ENCONTRADO` | El NIT (o el nombre) no está en el maestro | Pedir la creación del proveedor en SAP o verificar el NIT con el solicitante |
| `RC1:PROVEEDOR_INACTIVO` | El proveedor existe pero está inactivo | Consultar a Compras si se reactiva o se cotiza con otro proveedor |
| `RC2:APROBACION_AUSENTE` | No vino el correo de aprobación | Pedir al solicitante la aprobación de su líder |
| `RC2:APROBACION_SIN_APROBADO` | El correo no dice "Aprobado" (o dice "No aprobado") | Pedir una aprobación explícita |
| `RC2:APROBADOR_NO_AUTORIZADO` | Quien aprueba no es aprobador del centro de costo | Pedir la aprobación a un aprobador del centro, o corregir el centro de costo si la compra corresponde a otra área |
| `RC3:APROBADOR_SIN_TOPE` | Quien aprueba no tiene tope en ese centro | Igual que el anterior; si ningún aprobador alcanza el monto, escalar |
| `RC3:MONTO_SUPERA_TOPE` | El monto supera el tope del aprobador | Pedir la aprobación de un aprobador con tope suficiente |
| `RC4:SUBAREA_NO_PERTENECE` · `RC4:CENTRO_COSTO_INEXISTENTE` | El centro o la subárea no son válidos | Corregir la imputación con el solicitante |
| `RC5:DIFERENCIA_COTIZACION` | La cotización difiere más de 2 % | Confirmar cuál valor vale; si es la cotización, el solicitante debe actualizar la solicitud y la aprobación |
| `RC5:COTIZACION_AUSENTE` | No hay cotización | Confirmar si se procede sin cotización (es un desvío de proceso) |
| `RC6:IVA_DERIVADO` | No se informó IVA; se usa el del proveedor | Confirmar que el indicador derivado es correcto |
| `RC7:CONDICION_PAGO_DERIVADA` | No se informó condición de pago; se usa la del proveedor | Solo informar |
| `RC8:COMPRA_RETROACTIVA` | La factura es anterior a la solicitud | Confirmar conscientemente; queda marcada `retroactiva = true` para medir el desvío |
| `RC9:APROBACION_ANTERIOR_A_SOLICITUD` | La aprobación es anterior a la solicitud | Confirmar si la aprobación corresponde a esta solicitud |
| `RC10:TOTAL_INCONSISTENTE` | Cantidad × valor unitario ≠ total | Pedir al solicitante corregir el Excel |
| `RC6:IVA_INDICADOR_DESCONOCIDO` · `RC7:CONDICION_PAGO_DESCONOCIDA` | Código que no existe en el maestro | Corregir el código con el solicitante |

## La orden de compra

- Sociedad y organización de compras `1000`. Una posición (número 10) con la descripción recortada a 40 caracteres (límite del texto breve en SAP).
- Unidad `H` si se compra por horas; si no, `UN`.
- `excepciones` lista las confirmaciones aceptadas y quién confirmó.
- La evidencia de aprobación se genera en `out/<caso>/aprobacion.txt` y `out/<caso>/aprobacion.pdf` (mismo contenido). Su sha256 queda en la OC (`aprobador.evidencia_sha256`).
- `oc_leer_excel` lee una `solicitud.xlsx` (solo `.xlsx` dentro del proyecto) y valida sus filas con el mismo esquema que `solicitud.json`.
- `oc_crear` es idempotente: repetir la misma solicitud devuelve la OC existente.

## Compras retroactivas

La dirección quiere **medir** cuántas OC se crean después de la factura. Hoy no se rechazan: se crean con confirmación y quedan marcadas con `retroactiva = true` en `out/control.csv`. Decidir si se toleran o se rechazan es una política fuera del alcance del agente.
