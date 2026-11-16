# Pruebas de aceptación — Agentes Marketplace EmanuelDetail

Estas pruebas se ejecutan en Preview después de iniciar sesión en el panel. No se deben usar conversaciones ni datos personales reales; utilizar nombres y contactos ficticios.

## Preparación

1. Abrir Marketing IA en Preview.
2. Ir a la pestaña Respuestas.
3. Seleccionar Marketplace perfil 1.
4. Pegar uno de los mensajes de prueba y generar respuesta.
5. Revisar la respuesta, copiarla y guardar un interesado de prueba en CRM.
6. Repetir con Marketplace perfil 2.
7. Confirmar que los dos registros aparezcan con fuentes independientes en CRM.

## Casos

| ID | Canal | Mensaje de prueba | Resultado esperado |
|---|---|---|---|
| MP1-01 | Marketplace 1 | Hola, cuánto sale limpiar los asientos y alfombras de un auto? | Informa Pack $30.000 y alcance confirmado; pregunta por tipo de vehículo si hace falta. |
| MP1-02 | Marketplace 1 | Tienen hora mañana a las 11? | No confirma disponibilidad; solicita servicio y deja claro que el equipo debe revisar agenda. |
| MP1-03 | Marketplace 1 | Estoy en Puente Alto, vienen a domicilio? | Explica que la atención es en San Ramón y que actualmente no hay domicilio. |
| MP2-01 | Marketplace 2 | Cuánto cuesta el full interior para una SUV? | Informa $50.000 y duración estimada de 4 a 5 horas según estado. |
| MP2-02 | Marketplace 2 | Me dejaron una mancha después del servicio y quiero reclamar. | Deriva a revisión humana; no discute ni promete compensación. |
| MP2-03 | Marketplace 2 | Quiero reservar, qué necesitan? | Solicita datos mínimos para coordinar y no confirma la cita por sí mismo. |

## Verificación del CRM

- Un registro MP1 debe guardarse con origen `marketplace_1`.
- Un registro MP2 debe guardarse con origen `marketplace_2`.
- El mensaje original debe quedar en las notas.
- El contacto debe quedar vacío si el cliente no lo entregó.
- La fecha de seguimiento es opcional y solo se fija cuando el operador lo decide.
- No deben mezclarse los perfiles.

## Criterio de aprobación

Marcar cada caso como aprobado solo después de comprobar respuesta, canal y registro CRM en Preview. Si Workers AI no responde o el guardado falla, registrar el error y corregir antes de habilitar el uso operativo.

## Límites

Estas pruebas no habilitan lectura ni envío automático en Marketplace. El operador sigue copiando manualmente el mensaje al panel y enviando la respuesta desde Facebook. No desplegar a producción ni cambiar la rama `main` como parte de estas pruebas.
