# Respaldo y recuperación del servicio PostgreSQL común

La CLI `orbita_store.service_backup` respalda el servicio completo y lo restaura
en un volumen y un contenedor nuevos. Incluye datos, secuencias, roles, contraseñas,
permisos, funciones, extensiones y WAL. Usa `pg_basebackup` y `pg_verifybackup` de
la misma imagen PostgreSQL que el origen. La copia del origen sigue disponible.

## Preparación

Usa el Python, Node y Docker de la instalación cualificada. La imagen admitida es
`sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685`.
El operador debe tener su configuración privada con `host`, `port`, `dbname`,
`user`, `password` e `instanceId`; la configuración runtime no sustituye al operador.
El identificador de contenedor debe tener sus 64 caracteres y corresponder a esa
instancia, imagen, volumen y puerto de loopback. La CLI comprueba esa identidad.

Cierra la app y sus trabajos mediante sus controles de cierre. El respaldo exige
cero clientes y rechaza una instancia en uso. Durante la captura impide conexiones
runtime nuevas mediante una intención de mantenimiento autenticada y recuperable.
No cancela clientes ajenos ni reinicia el servidor original.

En PowerShell, define rutas absolutas para `$OrbitaPackage` (el directorio
`agent-forensic-handoff`), `$OrbitaPython`, `$OrbitaNode`, `$OperatorConfig`,
`$BackupRoot` y `$PrivateRoot`, y el `$ContainerId` verificado. Los directorios
padres deben existir; `$BackupRoot` debe ser un nombre nuevo. `$PrivateRoot` debe
ser un directorio privado del operador, separado del archivo de respaldo y de Git.

```powershell
$env:PYTHONPATH = Join-Path $OrbitaPackage 'python'
$KeyFile = Join-Path $PrivateRoot 'service-key.bin'
$IntentFile = Join-Path $PrivateRoot 'maintenance-intent.json'
& $OrbitaPython -X utf8 -B -m orbita_store.service_backup backup `
  --operator $OperatorConfig --container $ContainerId `
  --destination $BackupRoot --key-file $KeyFile --intent $IntentFile `
  --node $OrbitaNode --max-seconds 21600
if ($LASTEXITCODE -ne 0) { throw 'Respaldo fallido; conservar recibos y archivos' }
```

El resultado correcto es `COMPLETE_SERVICE_BACKUP_ENCRYPTED`. El directorio debe
contener exactamente `globals.enc`, `database.enc` y `manifest.json`. La clave de
64 bytes permanece en `$KeyFile`; conserva una copia protegida de esa clave
separada del archivo cifrado. El manifiesto contiene inventario y hashes,
autenticados con HMAC; los dos miembros están cifrados con AES-256-GCM. La CLI no
escribe un archivo intermedio de datos sin cifrar.

La reserva mínima para crear la copia es 55 GiB más tres veces el tamaño de la
base. Cada miembro tiene un límite de 50 GiB y el manifiesto de 16 MiB. La captura
compara todos los bytes de tablas, cada valor de secuencia y el DDL nativo antes y
después; una diferencia conserva el fallo y no publica un manifiesto completo.

## Restauración independiente

`$RestorePrivate` debe ser una ruta nueva, dentro de almacenamiento privado del
operador. Se autentican todos los miembros y se mantienen sus mismos handles
antes de crear el destino. Después se extrae el archivo nativo, se verifican todos
sus archivos y WAL con `pg_verifybackup`, y se inicia el contenedor nuevo.

```powershell
$RestorePrivate = Join-Path $PrivateRoot 'independent-restore'
& $OrbitaPython -X utf8 -B -m orbita_store.service_backup restore `
  --directory $BackupRoot --private-directory $RestorePrivate `
  --key-file $KeyFile --node $OrbitaNode --max-seconds 21600
if ($LASTEXITCODE -ne 0) { throw 'Restauración fallida; conservar el destino y sus recibos' }
```

El resultado correcto es `PASS_INDEPENDENT_COMPLETE_SERVICE_RESTORE`, con
`nativeVerification=PASS_PG_VERIFYBACKUP_ALL_FILES_AND_WAL`. `COMPARISON.json`
debe contener `equal: true`: comprueba DDL completo, tablas con todas sus columnas,
secuencias, roles, membresías, propietarios de extensiones y configuración del
servidor. La restauración conserva los roles originales; añade un operador
temporal exclusivo, cuya configuración queda en `operator.json` privado, y repone
en el destino el estado LOGIN original registrado en el manifiesto.

El puerto nuevo aparece en `RESTORE.json`. Para probar la app usa una copia privada
de su configuración runtime con ese puerto y con sus trabajos automáticos y acceso
externo desactivados. Mantén los identificadores y capacidades originales del
workspace. La CLI verifica la recuperación del servicio; las comprobaciones
funcionales de la app y la aceptación del usuario siguen siendo pasos propios.

Para cerrar únicamente el servicio restaurado después de la prueba:

```powershell
& $OrbitaPython -X utf8 -B -m orbita_store.service_backup stop-restored `
  --receipt (Join-Path $RestorePrivate 'OWNED-SERVICE.json')
if ($LASTEXITCODE -ne 0) { throw 'No se ha confirmado el cierre del destino' }
```

El cierre comprueba de nuevo ID, imagen, etiquetas y volumen. Conserva el volumen,
el archivo cifrado, la clave y los recibos. Un error de restauración también
conserva sus artefactos y cierra sólo los contenedores de ese intento.

## Recuperar el acceso tras una interrupción

El flujo normal restaura el LOGIN original antes de publicar el respaldo. Si el
proceso se interrumpe, usa la misma instancia, clave e intención:

```powershell
& $OrbitaPython -X utf8 -B -m orbita_store.service_backup recover `
  --operator $OperatorConfig --container $ContainerId `
  --intent $IntentFile --key-file $KeyFile --node $OrbitaNode
```

Los estados correctos son `ORIGINAL_AUTHORITY_ALREADY_PRESENT` u
`OWN_LOGIN_CHANGE_RESTORED`. Un propietario de mantenimiento todavía vivo, otra
versión del rol, cambios externos de atributos o membresías, o una identidad
distinta impiden la recuperación automática. Conserva el fallo; no sustituyas
esta comprobación por un `ALTER ROLE` manual.

Una copia y un volumen de prueba en el mismo host acreditan restauración local.
La protección frente a pérdida de ese host requiere custodiar el archivo y la
clave en ubicaciones independientes; este comando no transfiere nada a terceros.
