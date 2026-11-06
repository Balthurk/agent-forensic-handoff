# Comprobación de archivos históricos de servicios

Este comando comprueba la recuperación de los archivos históricos de PostgreSQL
y del conjunto Cassandra/JanusGraph. El recibo de cada ejecución identifica qué
archivo se recuperó, los recursos creados y las comparaciones realizadas.

El consumidor utiliza un archivo autenticado y crea destinos Docker nuevos.
Al terminar detiene sus propios servicios y conserva los volúmenes, los archivos
derivados y los recibos. Esta entrada comprueba la recuperación; no deja un
servicio final en funcionamiento ni elimina los originales.

## Preparación

Se requieren el producto PostgreSQL común, sus dependencias de Python, Docker
Desktop activo, Node y las imágenes exactas que exige el archivo. La cualificación
local utiliza Windows x64, Python 3.12.10 y Node 24.20.0. El consumidor no descarga
imágenes automáticamente. Los formatos admitidos son los archivos de custodia
PG01 de PostgreSQL 16 y del conjunto Cassandra 4.0.6 / JanusGraph 1.1.0.

Se custodian por separado:

- El directorio de archivo cifrado completo, incluido su manifiesto.
- Su clave, guardada en un archivo privado.
- Para PostgreSQL histórico, el catálogo original y las credenciales privadas
  del usuario archivado. El destino usa un puerto nuevo en loopback.
- El código y las versiones de runtime fijadas en la entrega.

La carpeta privada de salida debe ser nueva y estar bajo un directorio privado
ya preparado por el operador. Contendrá metadatos y credenciales de recuperación.
No se pasa una contraseña como argumento de consola.

## Grafo histórico

La comprobación requiere al menos 8 GiB disponibles en Windows, 7 GiB en la VM
Docker y 60 GiB libres en disco al iniciar. Su monitor conserva los fallos por
presión de memoria. También verifica que el plazo de expiración de los datos
archivados permite completar la recuperación. No cambia los TTL originales.

```powershell
$Python = 'C:\Orbita\.venv-orbita\Scripts\python.exe'
$Product = 'C:\Orbita\products\orbita'
$Recovery = Join-Path $Product 'agent-forensic-handoff\scripts\recovery\recover.py'
& $Python -X utf8 -B $Recovery graph `
  --product $Product `
  --archive 'D:\OrbitaBackups\graph-archive' `
  --key-file 'D:\OrbitaPrivate\graph-key.bin' `
  --private-directory 'D:\OrbitaPrivate\graph-restore-new' `
  --node 'C:\OrbitaRuntime\node-v24.20.0-win-x64\node.exe'
```

Un resultado completo compara las celdas, el esquema, los tiempos de escritura
y las expiraciones antes de arrancar JanusGraph. Después compara todas las
propiedades y relaciones mediante ambos lectores nuevos. Los puertos originales
no se usan para reconstruir ni para alimentar esas comparaciones.

El modo predeterminado es `--graph-expiry-mode strict`: exige que todas las
celdas archivadas sigan vigentes durante el plazo restante más una hora.
Para comprobar un archivo cuyos TTL ya han vencido se debe seleccionar
explícitamente `--graph-expiry-mode at-restore`. Después de autenticar ambos
miembros, este modo registra cada identidad inequívocamente caducada y exige su
ausencia exacta. Conserva todas las demás celdas, esquema, tiempos de escritura
e intervalos originales de expiración. Rechaza intervalos ambiguos o caducidades
que puedan ocurrir dentro del plazo restante más una hora. Nunca reinicia TTL
ni cambia el reloj o el archivo.

El modo temporal sigue exigiendo el mismo grafo completo por ambos lectores.
Produce `EXPIRY-PROJECTION.json` con la clasificación y los digests de los
catálogos capturado y esperado. Su estado de éxito es
`PASS_INDEPENDENT_TEMPORAL_NATIVE_GRAPH_RESTORE`; los datos ya caducados se
declaran ausentes, no recuperados. El modo estricto conserva su estado de éxito
anterior. Esta opción no se admite para PostgreSQL.

## PostgreSQL histórico

```powershell
$Python = 'C:\Orbita\.venv-orbita\Scripts\python.exe'
$Product = 'C:\Orbita\products\orbita'
$Recovery = Join-Path $Product 'agent-forensic-handoff\scripts\recovery\recover.py'
& $Python -X utf8 -B $Recovery postgres `
  --product $Product `
  --archive 'D:\OrbitaBackups\legacy-pg-archive' `
  --key-file 'D:\OrbitaPrivate\legacy-pg-key.bin' `
  --catalog-file 'D:\OrbitaPrivate\legacy-pg-catalog.json' `
  --operator-file 'D:\OrbitaPrivate\legacy-pg-operator.json' `
  --private-directory 'D:\OrbitaPrivate\legacy-pg-restore-new' `
  --memory-mib 2048 `
  --node 'C:\OrbitaRuntime\node-v24.20.0-win-x64\node.exe'
```

La recuperación verifica los archivos y WAL con `pg_verifybackup`, arranca el
destino con su configuración original y compara el catálogo y los datos
completos. Los valores de memoria admitidos son 512 o 2048 MiB; debe usarse el
perfil fijado por la cualificación correspondiente.

Esta entrada es distinta de la recuperación de la base PostgreSQL común de
Órbita, documentada en
`agent-forensic-handoff/docs/postgresql-service-recovery.md`.

## Resultado

La salida de consola identifica el estado y la ruta del recibo privado. La
carpeta conserva `RESTORE-RESULT.json` y las identidades de los recursos creados.
Un fallo permanece como fallo y requiere inspeccionar ese recibo antes de otro
intento en una carpeta nueva. El límite exterior máximo sigue siendo seis horas.

Una restauración calificada acredita la comprobación indicada por su recibo.
La entrega final requiere además la revisión de publicación, la reconstrucción
remota y los cierres independientes de consumidores.

El cargador del grafo usa una copia temporal de cada tabla en un tmpfs privado de
128 MiB (hasta 112 MiB de entrada). El staging autenticado permanece de solo
lectura; se comprueban todos los bytes de origen y copia al terminar.
