# Importación explícita de contenido anterior

La entrada de producto es `python -m orbita_store.legacy_cli`, ejecutada desde
`agent-forensic-handoff/python` con el Python configurado para el almacén común.
Requiere las dependencias de PostgreSQL del producto. La conversión de un volumen
Parquet necesita también las dependencias de `app/requirements-volume.txt`.

```powershell
& $Python -X utf8 -B -m orbita_store.legacy_cli `
  --config $RuntimeConfig `
  --plan $ReviewedPlan `
  --plan-sha256 $ReviewedPlanSha256 `
  --destination $NewBoundDestination `
  --stage $NewBoundStage
```

Todos los caminos deben ser absolutos. Destino y staging son localizadores
distintos dentro del mismo espacio PostgreSQL configurado. El destino tiene que
estar libre. El plan debe enumerar los archivos, SHA256, familias, destinos y
derivaciones revisados; el programa no los infiere. Para un índice vec0 anterior,
se proporciona además `--vector-extension` con la biblioteca cuyo hash admite
el importador. No se regeneran vectores.

Se puede generar un plan para una raíz seleccionada expresamente con:

```powershell
& $Python -X utf8 -B -m orbita_store.legacy_plan `
  --source $OriginalDataRoot --output $NewPlanOutsideSource
```

Este paso sólo lee y enumera el origen. Su salida contiene el SHA256 del plan
para el comando de importación anterior. Reconoce las rutas de almacenes del
formato anterior; un SQLite desconocido, una referencia de biblioteca ausente
o un formato incompleto requieren revisión y producen un error. No sigue las
rutas absolutas antiguas de la biblioteca. No sobrescribe un plan existente ni
lo escribe dentro del origen. Antes de importar, revisar los destinos, familias,
entradas en custodia y derivaciones del documento generado.

El plan está limitado a 50.000 entradas y 8 MiB de bytes UTF-8 serializados;
el escaneo de origen, a 50 GiB, y la configuración, a 1 MiB. Se rechazan claves JSON
duplicadas, enlaces, archivos que puedan cambiar durante la lectura y un
WAL/journal con contenido. Un origen con WAL requiere primero una adquisición
coherente documentada. No abrir ni truncar una base original para forzar el paso.

Un `case.sqlite` vacío de un staging de documento con nombre reconocido sólo se
conserva en custodia si es su único archivo y no figura como caso de la biblioteca.
No crea un almacén ni un caso operativo. Los demás formatos incompletos se rechazan.
El ledger anterior de Janus se importa como `janus-ledger.pgstore`: sus recibos
históricos se conservan y no se convierten en una verificación del espejo actual.

Las familias de autoridad `access` y `lease` no se importan mediante esta entrada.
La configuración debe usar el rol restringido `orbita_runtime`, la instancia
esperada y capacidades del espacio seleccionado. No se aceptan credenciales de
operador como alternativa ni se activan trabajos automáticos o acceso externo.

El recibo íntegro se publica dentro de PostgreSQL, junto con el contenido, en
`<destino>/.orbita-legacy/receipt.json`. La salida JSON contiene su dirección,
hash, conteos y cierre observado del consumidor propio; no contiene capacidades,
contraseñas ni filas originales. Guardar esa salida en el registro de operación.

Una ejecución fallida conserva su staging para verificar y reanudar el mismo
plan. No sobrescribe un destino publicado. Si el proceso se interrumpe después
de publicar o la salida informa `inspect_destination_before_retry`, inspeccionar
el recibo interno y realizar lectura independiente antes de decidir la siguiente
operación; no interpretar la falta de salida como rollback.

Esta entrada convierte contenido enumerado SQLite/archivos/Parquet. La migración
privilegiada de dominios de acceso, la conversión de respaldos cifrados v1 y el
respaldo/restauración del servicio PostgreSQL completo son operaciones separadas.
