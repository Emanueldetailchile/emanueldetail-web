# EmanuelDetail Business Panel

Panel independiente de accesos comerciales. No modificar el sitio público.

## Seguridad

Los secretos `PANEL_PASSWORD` y `SESSION_SECRET` están configurados como secretos de entorno en Cloudflare Pages; no están almacenados en el repositorio. El panel bloquea el acceso si faltan.

El panel solo agrupa enlaces; no implica conexión de API ni sincronización de mensajes.
