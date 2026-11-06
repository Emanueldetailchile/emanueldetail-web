# EmanuelDetail Marketing IA — estado de Preview

Este documento describe la versión de pruebas de la rama `marketing-ia-mvp`. No representa una autorización para publicar cambios en la web pública.

## Funciones disponibles en el código de Preview

- Panel adaptable a PC y Android, instalable como PWA.
- Generación de borradores con plantillas y con Workers AI.
- Cola de publicaciones, edición, aprobación interna y copia de textos. **Aprobar no publica en redes.**
- Imágenes de marketing cargadas en el bucket R2 de Preview.
- Sincronización central en D1 Preview para la cola de publicaciones, CRM, calendario editorial y agenda.
- CRM con canal de origen separado para Marketplace 1 y Marketplace 2, servicio solicitado, notas, estado comercial y fecha del próximo seguimiento.
- Indicadores visuales de seguimiento vencido y seguimiento para hoy. No hay notificaciones push, SMS ni correo automáticos.
- Agenda con estimación de duración; las solicitudes se guardan como pendientes y requieren confirmación humana.
- Respuestas rápidas por plantilla y sugerencias de IA. Se copian manualmente; el panel no envía mensajes a las plataformas.
- Exportación e importación de respaldo JSON para los borradores.

## Marketplace y redes sociales

- Marketplace 1 y Marketplace 2 se registran por separado en el CRM.
- Los mensajes de Marketplace deben copiarse manualmente al panel para preparar una respuesta.
- No hay integración autorizada que permita leer, sincronizar o responder automáticamente los chats de Marketplace.
- No se debe prometer publicación automática en grupos o Marketplace.
- La conexión con Meta no se considera activa por la existencia de código OAuth o webhooks. Requiere aprobación de la aplicación, permisos concedidos, credenciales y secretos configurados, suscripciones de webhook y pruebas reales.
- Las respuestas de IA son propuestas para revisión humana. No se envían directamente por Facebook, Instagram ni WhatsApp.

## Primer acceso al panel

- El primer acceso administrativo de Marketing IA requiere configurar `MARKETING_ADMIN_BOOTSTRAP` en Cloudflare Pages, entorno **Preview**.
- La clave provisional se introduce directamente en el panel; el primer ingreso obliga a establecer una contraseña definitiva.
- No compartir contraseñas, tokens ni secretos por chat.
- Resend y `RESEND_API_KEY` son necesarios para recuperación por correo, no para el primer ingreso.

## Validación pendiente

1. Configurar la clave inicial en el entorno Preview e ingresar al panel.
2. Probar en navegador la sincronización de cola, CRM, fechas de seguimiento, calendario, agenda y carga de imágenes.
3. Confirmar el estado de la revisión de Meta antes de configurar OAuth, webhooks o permisos.
4. Hacer pruebas de extremo a extremo después de que las autorizaciones y credenciales estén disponibles.

## Protección de producción

- La rama de trabajo es `marketing-ia-mvp`.
- La rama `main` y la web pública permanecen sin cambios por esta tarea.
- No desplegar a producción, fusionar ramas ni modificar publicaciones, permisos o cuentas sociales sin autorización expresa.
