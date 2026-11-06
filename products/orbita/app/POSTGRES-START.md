# Instalación y arranque de Órbita con PostgreSQL común

Órbita guarda sus espacios y casos en una única base PostgreSQL y comprueba su
identidad antes de abrir la interfaz. Los ejemplos siguientes usan rutas de
ejemplo; las credenciales se conservan en archivos privados.

## Instancia común

El operador prepara una base PostgreSQL 16 en loopback, con una cuenta de
instalación y una contraseña de ejecución independiente de al menos 32
caracteres. El entorno verificado utiliza PostgreSQL 16.15 con la imagen
`sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685`.
La creación del servicio y su volumen debe tener una identidad propia y conservar
el recibo correspondiente.

La entrada de instalación es
`agent-forensic-handoff/python/install-common.py`. Recibe un único objeto JSON
por stdin, de hasta 1 MiB, con estas claves exactas:

| Campo | Contenido |
|---|---|
| `operator` | `host`, `port`, `dbname`, `user`, `password` |
| `instanceId` | UUID de la instancia que se instala o se comprueba |
| `runtimePassword` | Contraseña privada del rol `orbita_runtime` |

El servicio debe estar sin clientes de producto durante la instalación. El
instalador verifica esa condición, instala transaccionalmente todas las familias
y comprueba la identidad existente. Una repetición no rota silenciosamente la
contraseña. La salida describe la instalación y no contiene credenciales.

Para trasladar los bytes UTF-8 de un archivo privado al stdin del instalador sin
poner contraseñas en argumentos, puede usarse este relay:

```powershell
$Product = 'C:\Orbita\products\orbita'
$Python = 'C:\Orbita\.venv-orbita\Scripts\python.exe'
$InstallInput = 'C:\OrbitaPrivate\install-input.json'
$Installer = Join-Path $Product 'agent-forensic-handoff\python\install-common.py'
$Relay = @'
from pathlib import Path
import subprocess,sys
with Path(sys.argv[3]).open('rb') as f:
    value=f.read(1024*1024+1)
result=subprocess.run([sys.argv[1],'-I','-X','utf8','-B',sys.argv[2]],input=value)
raise SystemExit(result.returncode)
'@
& $Python -X utf8 -B -c $Relay $Python $Installer $InstallInput
if ($LASTEXITCODE -ne 0) { throw 'La instalación no se completó' }
```

Este comando no crea automáticamente un servicio PostgreSQL ni el archivo
privado de entrada. Ambos deben estar preparados por el operador.

## Perfil de ejecución

El operador provisiona el espacio mediante
`orbita_store.admin.provision_workspace`. El resultado contiene una capacidad
privada; se guarda directamente en un perfil protegido y no se imprime ni se
publica en los recibos. Para un espacio nuevo, la operación y su UUID se registran
antes de repetirla. Los espacios migrados conservan sus identidades y permisos.

El perfil de ejecución tiene `schema: 1`, la conexión loopback al mismo `dbname`,
`user: "orbita_runtime"`, su contraseña, `instanceId` y una sola entrada en
`bindings`. Esa entrada contiene `root`, `workspaceId` y `capability`.

`root` es una ruta absoluta ordinaria usada como localizador lógico. El valor
pasado como `-Data` debe pertenecer a esa raíz. No es una base separada por caso
o espacio. Los enlaces y rutas que escapan del vínculo se rechazan.

Para el modo personal se entrega un perfil de un espacio `personal`. Para el modo
administrado se entrega un perfil `control`; los usuarios acceden después con
las sesiones y permisos del dominio de control. Los perfiles de pruebas no se
presentan como perfiles finales del usuario.

## Modelo y comprobación del arranque

El arranque utiliza el snapshot local
`Xenova/paraphrase-multilingual-MiniLM-L12-v2`, revisión
`2c4055b12046f11709e9df2c122e59ffbdc2f900`. La carpeta se indica mediante
`-ModelHome`. La herramienta `semantic-model status --deep` comprueba los activos;
la descarga, si hace falta, tiene una entrada explícita `semantic-model fetch
--allow-download`. Esta guía no ejecuta descargas ni inferencias.

Antes de abrir un puerto:

```powershell
$Product = 'C:\Orbita\products\orbita'
$Node = 'C:\OrbitaRuntime\node-v24.20.0-win-x64\node.exe'
$Python = 'C:\Orbita\.venv-orbita\Scripts\python.exe'
$ModelHome = 'C:\OrbitaRuntime\models'
$RuntimeConfig = 'C:\OrbitaPrivate\runtime-personal.json'
$Data = 'C:\OrbitaData\personal'

& (Join-Path $Product 'app\START.ps1') `
  -Mode Personal -Data $Data -Port 4322 `
  -PostgresConfig $RuntimeConfig -Python $Python -Node $Node `
  -ModelHome $ModelHome -CheckOnly
```

`READY` acredita las comprobaciones de ese arranque y el cierre de su consumidor.
`-CheckOnly` no deja un servidor escuchando. El arranque normal usa el mismo
comando sin `-CheckOnly`; la interfaz queda en `http://127.0.0.1:4322`.

Para el modo administrado se cambia a `-Mode Managed`, al perfil de control y a
su `-Data`; el puerto predeterminado es 4492. El perfil se valida antes de abrir
el listener. Las contraseñas de acceso administrado se entregan por su canal
privado, fuera de esta guía.

Si falta la configuración, no coincide la instancia, la raíz no está autorizada
o falta el modelo requerido, se conserva el código de error y se corrige esa
entrada concreta. El operador no sustituye el perfil por sus credenciales de
administración.

## Importación y conservación

La incorporación de datos anteriores sigue [POSTGRES-IMPORT.md](POSTGRES-IMPORT.md)
con un plan revisado y un destino nuevo. La restauración completa del servicio
sigue la [guía de recuperación](../agent-forensic-handoff/docs/postgresql-service-recovery.md).
Antes de retirar copias, se comprueban el respaldo, la reconstrucción y los
consumidores que exige la entrega. Git conserva el código; los datos y sus claves
tienen su propia custodia.
