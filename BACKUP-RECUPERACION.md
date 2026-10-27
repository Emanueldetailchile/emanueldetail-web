# Respaldo y recuperación de EmanuelDetail

## Qué cubre el respaldo automático

El workflow **Backup del sitio EmanuelDetail** genera un ZIP descargable con los archivos versionados del repositorio y un archivo SHA-256 para comprobar la integridad. Se ejecuta al recibir cambios en `main`, semanalmente y manualmente desde GitHub Actions. Cada artefacto queda disponible durante 90 días.

## Cómo generar y descargar una copia

1. Abre la pestaña **Actions** del repositorio.
2. Selecciona **Backup del sitio EmanuelDetail**.
3. Pulsa **Run workflow** y confirma la rama.
4. Abre la ejecución terminada correctamente y descarga el artefacto `EmanuelDetail-backup-...`.
5. Guarda el ZIP fuera de GitHub, por ejemplo en el computador y en un disco externo o almacenamiento seguro separado.

No dependas únicamente de los artefactos de Actions: caducan a los 90 días.

## Restaurar la parte estática

1. Descomprime el ZIP y conserva el archivo `RESPALDO-METADATOS.txt`.
2. Revisa `README`, configuración y el directorio de publicación de la plataforma de destino. Actualmente Cloudflare Pages utiliza `public` como directorio de salida.
3. Publica el directorio estático correspondiente en un proveedor compatible con HTML/CSS/JavaScript.
4. Comprueba la página de inicio, servicios, imágenes, enlaces de Instagram y WhatsApp, tienda, formularios y consola del navegador.

Cambiar de proveedor no garantiza que las funciones del backend funcionen sin adaptación. Las rutas `/api/*`, la configuración de base de datos y el almacenamiento deben migrarse y probarse.

## Elementos que requieren respaldo separado

Este ZIP **no** incluye datos alojados fuera de Git ni secretos. Para una recuperación completa, mantener respaldos independientes y periódicos de:

- **Cloudflare D1:** exportación de cada base de datos utilizada por la web; comprobar que el archivo exportado pueda leerse.
- **Cloudflare R2:** inventario y copia de los objetos/imágenes almacenados en cada bucket.
- **Configuración:** nombres de variables de entorno, bindings, rutas, configuración de Pages/Workers y pasos de despliegue. Guardar los valores secretos en un gestor de contraseñas; nunca poner claves, tokens o contraseñas en el repositorio ni en el ZIP.
- **Dominio y cuentas:** registrar dónde se administra el dominio, quién tiene acceso y cómo recuperar las cuentas con autenticación de dos factores.

## Prueba de recuperación

Al menos una vez, restaurar una copia en un proyecto de prueba separado y comprobar el sitio. No cambiar producción hasta validar la prueba. Un respaldo solo es confiable cuando se ha verificado su restauración.

## Limitación actual

El workflow respalda el código que GitHub tiene versionado. No confirma por sí mismo el estado del despliegue público ni crea copias de D1/R2. Esas tareas deben configurarse y probarse por separado.
