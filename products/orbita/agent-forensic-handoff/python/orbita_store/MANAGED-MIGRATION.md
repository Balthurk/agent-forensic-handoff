# Publicación explícita de controles históricos

`managed_migration.py` es una herramienta de operador. El importador ordinario
sigue rechazando las familias `access` y `lease`. Ninguna ruta de consulta ni
worker importa SQLite o reconstruye autoridad a partir de un archivo.

Primero se crean espacios personales de staging con credenciales privadas.
`import_access_snapshot` acepta una instantánea SQLite coherente, su SHA256 y
el destino `access.pgstore`; exige las ocho tablas originales y verifica todos
los valores tipados y rowids con una conexión nueva. El operador debe conservar
también la procedencia y la custodia del DB/WAL/SHM de adquisición. Las raíces
de contenido se importan por separado dentro de cada hijo. Los archivos
cifrados conservan sus bytes bajo `backups/<UUID>.orbita`.

Tras cerrar los consumidores propios y comprobar el contenido contra las
fuentes, `stage_manifest` identifica todas las tablas de contenido, objetos,
chunks, revisiones y estados de restauración del staging. No sustituye la
comparación SQLite–PostgreSQL: detecta cambios posteriores a esa comparación.
`freeze_stages` revoca las admisiones y confirma el cierre por PID más instante
de inicio. Un consumidor vivo conserva su proceso; el staging queda congelado
y la publicación falla hasta que se cierre y vuelva a comprobarse.

`publish_domain` exige el mismo manifiesto y publica control, hijos, políticas
privadas y recibo en una transacción. Conserva usuarios, contraseñas derivadas,
sesiones, revisiones, auditoría y payloads; no renueva fechas. Rota todas las
capacidades de staging. Un espacio purgado exige su recibo original y ausencia
de contenido. Puede conservarse después de eliminar su cuenta propietaria:
el tombstone sigue inactivo y no concede derechos.

El resultado queda ligado a un `operation_id` y al hash de la petición. Ante
una respuesta perdida, consultar `publication_receipt` desde una conexión
nueva antes de decidir cualquier reintento. La misma operación no admite otra
petición. Un fallo de publicación conserva el congelado ya confirmado.

La tabla privada `managed_legacy_archives` vincula el archivo a su control,
espacio, UUID, SHA256 del payload textual original y SHA256 del ciphertext.
La aplicación resuelve la ruta sólo si la fila actual sigue coincidiendo y
comprueba los bytes. Conserva intacto el payload original. Esta correspondencia
y los recibos pertenecen al respaldo integral del servicio; no se exportan
como contenido de un espacio.

La publicación no arranca servicios ni activa trabajo automático. Resolver la
ruta de un ciphertext v1 no demuestra su restauración: la conversión v1 debe
autenticarlo íntegramente antes de interpretar su contenido y se cualifica por
separado.
