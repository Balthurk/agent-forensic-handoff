# Instalar Órbita I04

Esta rama, `orbita-i04-publica`, conserva la versión completa de Órbita hasta I04. El código de la aplicación está en `products/orbita`. Incluye I01–I04 y sus pruebas; utiliza el almacenamiento anterior a PG01. La migración PostgreSQL común y los incrementos posteriores se desarrollan por separado.

El código ejecutable es el mismo que el corte I04 del commit `729b549005ca2c12e0d1995083de62e527c292ba`, cualificado y cerrado en `ca28eb6057d2756108cb36b7158359055a6c97e0`. [QUALIFICATION-I04.json](products/orbita/QUALIFICATION-I04.json) registra la validación histórica: 629 pruebas correctas, ninguna fallida y una omisión heredada de Windows, reconstrucción desde remoto, interfaz y recuperación dentro de su alcance. La publicación de esta rama añade instrucciones, sin modificar ese código.

## Instalación en Windows

Requisitos: Git, Node.js 22.15 o superior (I04 se comprobó con Node24.15), Python3.12 o superior y PowerShell. Ejecuta lo siguiente en la carpeta donde quieras conservar el código:

```powershell
git clone --branch orbita-i04-publica --single-branch https://github.com/Balthurk/agent-forensic-handoff.git orbita-i04
Set-Location -LiteralPath .\orbita-i04
npm ci --prefix .\products\orbita\agent-forensic-handoff
py -3.12 -m venv .venv-orbita
& .\.venv-orbita\Scripts\python.exe -m pip install -r .\products\orbita\requirements-tested.txt
$env:AFH_PYTHON = (Resolve-Path -LiteralPath .\.venv-orbita\Scripts\python.exe).Path
$orbitaData = Join-Path $env:LOCALAPPDATA 'Orbita-I04\personal'
& .\products\orbita\app\START.ps1 -Data $orbitaData -Port 4322
```

Si usas otra versión compatible de Python, sustituye `py -3.12` por su ejecutable. La instalación de dependencias descarga paquetes; las bases y los datos se crean localmente al usar la aplicación. Si Windows bloquea el script por su política de ejecución, la ruta equivalente en esa misma consola es:

```powershell
$env:AFH_COSMOS_DATA = $orbitaData
$env:AFH_COSMOS_PORT = '4322'
$env:AFH_COSMOS_EMPTY_LIBRARY = '1'
node .\products\orbita\app\server.mjs
```

Abre **http://127.0.0.1:4322/**. La biblioteca empieza vacía. Importa tus propios archivos desde la interfaz. Conserva abierta la consola mientras uses Órbita y termina con Ctrl+C. Para arrancar otro día, vuelve a la carpeta clonada, establece AFH_PYTHON y ejecuta START.ps1 con la misma ruta de datos. Usa un puerto libre si4322 está ocupado.

También puedes [descargar el ZIP de esta rama](https://github.com/Balthurk/agent-forensic-handoff/archive/refs/heads/orbita-i04-publica.zip), descomprimirlo y ejecutar los pasos desde `npm ci` en la raíz descomprimida.

## Espacios administrados incluidos en I04

Son un modo local separado de la biblioteca personal. En una consola situada en la raíz clonada, con AFH_PYTHON configurado como arriba, inicializa una sola vez un directorio nuevo. El nombre admite3–64 caracteres alfanuméricos, punto, guion o subrayado y debe empezar por letra o número; la contraseña requiere al menos16 caracteres.

```powershell
$env:AFH_ACCESS_ROOT = Join-Path $env:LOCALAPPDATA 'Orbita-I04\managed'
$orbitaCredential = Get-Credential -Message 'Cuenta administradora local de Orbita'
$orbitaAccount = @{ username = $orbitaCredential.UserName; password = $orbitaCredential.GetNetworkCredential().Password } | ConvertTo-Json -Compress
$orbitaAccount | node .\products\orbita\app\access-cli.mjs init $env:AFH_ACCESS_ROOT
$orbitaAccount = $null
$orbitaCredential = $null
$env:AFH_ACCESS_PORT = '4492'
node .\products\orbita\app\access-server.mjs
```

Abre **http://127.0.0.1:4492/access**, inicia sesión y administra los espacios desde allí. En arranques posteriores omite la inicialización de la cuenta y conserva AFH_ACCESS_ROOT. El modo administrado de I04 deja deshabilitada la inferencia, según su contrato. Ambos servidores escuchan en la interfaz local; este procedimiento es instalación por equipo.

## Funciones con requisitos adicionales

La importación, consulta determinista y apertura de originales funcionan sin Codex instalado. Las respuestas que necesitan inferencia requieren una instalación y autenticación de Codex compatible; su ausencia se informa como CODEX_UNAVAILABLE. El código no aporta cuentas ni credenciales.

Los modos PostgreSQL, Parquet y JanusGraph requieren sus dependencias, servicios y configuración propios. El arranque personal anterior usa la ruta local de I04; no instala ni migra automáticamente estos servicios. Consulta [portabilidad y selección de Python](products/orbita/app/PORTABILITY.md), [alcance y verificación de I04](products/orbita/README.md) y los módulos/documentación incluidos para configurar esos modos.

## Qué contiene y qué se verificó

Se publica código, pruebas, esquemas, scripts, declaraciones de dependencias y licencia. No se publican bases de datos personales, corpus, claves, configuraciones privadas, modelos ni dependencias instaladas. El directorio de datos debe permanecer fuera del checkout.

La cualificación histórica incluye restauración y pruebas con servicios configurados. Algunas pruebas completas requieren fixtures privados que no se distribuyen; no se sustituyen por resultados inventados. La cualificación de interfaz conserva un defecto menor de favicon y avisos de consola documentados; no declara aceptación humana universal ni validación de todos los sistemas operativos.

Puedes listar las suites públicas sin ejecutarlas:

```powershell
& .\.venv-orbita\Scripts\python.exe .\products\orbita\scripts\check.py --list
```

Para la batería completa y sus servicios/fixtures, sigue el README de `products/orbita`. Instalar en otro equipo comienza con una biblioteca vacía; para trasladar datos existentes usa la función de respaldo/restauración correspondiente.

Licencia: [Apache-2.0](LICENSE).
