# EmanuelDetail Marketing IA — MVP 0.1

Panel web adaptable a Android y PC para crear borradores de publicaciones, adjuntar una foto, editar el texto, aprobar manualmente, revisar la cola y exportar/importar respaldos locales.

## Estado real
- Generación de borrador basada en plantillas y campos del negocio: implementada en navegador.
- Aprobación y cola local: implementadas.
- PWA instalable desde Android/PC: manifiesto y service worker incluidos.
- Respaldo JSON: implementado.
- IA generativa conectada a un proveedor: pendiente de credenciales y backend seguro.
- Conexión Meta OAuth/publicación a páginas e Instagram: pendiente de app Meta, permisos y tokens.
- Publicación automática en grupos de Facebook y Marketplace: no se debe prometer; Meta limita estas funciones y deben verificarse capacidades y políticas vigentes.
- Sincronización nube entre dispositivos: pendiente.
- La aprobación NO publica automáticamente en redes en esta versión.

## Uso
Abrir /marketing/ en el sitio. En Android, Chrome > menú > Instalar aplicación / Añadir a pantalla principal. En PC, usar el icono Instalar de Chrome si aparece.

Los borradores se guardan en localStorage del navegador y no se sincronizan entre dispositivos. Exportar JSON para respaldar y usar Importar en otro equipo.

## Despliegue
Cloudflare Pages usa el directorio public como salida y se conecta al repositorio GitHub. Los cambios de esta rama deben desplegarse como preview para validar antes de integrar a main.
