# EmanuelDetail Business Panel

Panel independiente de accesos comerciales. No modificar el sitio público.

## Requisitos de despliegue

Configurar en Cloudflare Pages los secretos `PANEL_PASSWORD` y `SESSION_SECRET` antes de publicar. `SESSION_SECRET` debe ser aleatorio, largo y privado. No incluir secretos en el repositorio. La aplicación bloquea el panel si los secretos no están configurados.

El panel solo agrupa enlaces; no implica conexión de API ni sincronización de mensajes.
