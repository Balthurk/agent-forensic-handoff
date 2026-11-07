# I06: fuentes largas y acciones agrupadas

Esta rama contiene la candidata I06, pendiente de su acumulada completa y sello. A13 conserva las omisiones de mensajes enteros y permite recorrer los originales completos con su revisión exacta. A15 agrupa los controles existentes y conserva selección, foco y permisos personales y gestionados.

Las pruebas focales A13 pasaron 26/26; la interfaz real personal y gestionada comprobó lectura, navegación, descarga literal, teclado y permisos con datos sintéticos. Estos resultados no sustituyen la acumulada ni constituyen aceptación humana.

PG01 está cerrado funcionalmente sobre FINAL4. F36 sigue íntegro y pendiente como deuda de escala por decisión explícita del usuario; no se presenta como PASS. El fallo histórico 22 procesos/60 segundos se conserva y el perfil aprobado de cualificación es local serial con todas las pruebas y sus plazos internos.

La guía heredada y los comandos reproducibles se conservan a continuación; sus recibos y cifras corresponden al corte PG01 descrito.

---

# Órbita — PostgreSQL común

PG01 migra la persistencia operativa a una única base PostgreSQL. Los espacios,
casos y dominios de acceso conservan sus identidades y permisos dentro de esa
base. Las rutas de datos son localizadores lógicos vinculados al espacio
autorizado. Los lectores de formatos anteriores se utilizan mediante las
entradas explícitas de importación y recuperación.

Cada entrega se identifica por sus fuentes y recibos de cualificación. La
regresión completa, equivalencia real, interfaz, F36, recuperación y
reconstrucción remota son requisitos separados; una prueba parcial no acredita
el conjunto. I01–I05 mantienen sus sellos históricos. PG01 precede a I06–I10.
La aceptación humana sólo puede proceder del usuario. Los documentos
`QUALIFICATION` anteriores describen los archivos y commits que identifican.

## Instalación y arranque

El entorno de cualificación utiliza Windows x64, Node **24.20.0**, Python
**3.12.10** y PostgreSQL **16.15**. Las dependencias de Python están fijadas en
`app/requirements-common.txt`. Desde la raíz del repositorio:

```powershell
npm ci --prefix .\products\orbita\agent-forensic-handoff
python -m venv .venv-orbita
& .\.venv-orbita\Scripts\python.exe -m pip install -r .\products\orbita\app\requirements-common.txt
```

La analítica de volumen utiliza dependencias opcionales fijadas en
`app/requirements-volume.txt`. Instálalas si vas a usar ese módulo o ejecutar
su cualificación:

```powershell
& .\.venv-orbita\Scripts\python.exe -m pip install -r .\products\orbita\app\requirements-volume.txt
```

El operador prepara el servicio común, su instalación completa y los perfiles
privados siguiendo la [guía de instalación y arranque](app/POSTGRES-START.md).
`app/START.ps1 -CheckOnly` valida las entradas y cierra su consumidor; el mismo
comando sin `-CheckOnly` abre la interfaz. La guía detalla los modos personal y
administrado, los puertos y el modelo local requerido. Una configuración ausente,
una instancia distinta o una raíz no autorizada impiden el arranque.

La instalación de la skill en la raíz del repositorio y la de esta variante de
Órbita son distintas. La disposición `app/` y `agent-forensic-handoff/` conserva
los imports del producto. Las dependencias, los modelos y los perfiles privados
no se incluyen en Git.

## Importación y recuperación

La [guía de importación](app/POSTGRES-IMPORT.md) exige originales conservados,
un plan con hashes y un destino explícito. Los perfiles de pruebas no son los
perfiles finales del usuario.

La [recuperación del servicio común](agent-forensic-handoff/docs/postgresql-service-recovery.md)
incluye el respaldo completo cifrado y la restauración independiente. El archivo
y su clave se custodian por separado. La [entrada de recuperación de servicios
anteriores](agent-forensic-handoff/scripts/recovery/README.md) documenta la CLI
para PostgreSQL y Cassandra/JanusGraph. Sus recibos delimitan lo comprobado;
una ejecución de una CLI no sustituye la comprobación funcional desde la app.

## Diagnóstico con procedencia privada

El diagnóstico histórico `app/orbita-preflight.mjs` utiliza un archivo de
procedencia con citas del usuario. Ese archivo se conserva en privado y no se
incluye en la exportación. Puede indicarse una ruta externa al código:

```powershell
& 'C:\OrbitaRuntime\node-v24.20.0-win-x64\node.exe' .\products\orbita\app\orbita-preflight.mjs --base-url 'http://127.0.0.1:4475' --provenance 'C:\OrbitaPrivate\provenance.json' --json 'C:\OrbitaPrivate\diagnostico-nuevo.json'
```

Se utiliza el archivo privado existente, conservando sus citas y hashes; no se
fabrican citas para completar la instalación. El argumento es opcional para
instalaciones anteriores que ya tengan su archivo local. El diagnóstico sólo
consulta el servicio local: sus observaciones no autorizan trabajo ni declaran
aceptación humana. Este diagnóstico es independiente del arranque de la app.

## Comprobación completa de Órbita

El comprobador es `agent-forensic-handoff/scripts/check.py`. `--list` enumera las
pruebas sin crear espacios ni servicios. `--preflight` comprueba entradas,
inventario de fuentes, identidad y durabilidad del servicio, ausencia de otros
clientes, imagen instalada y recursos: **8 GiB de RAM libre y 60 GiB de disco**.
Un preflight correcto no declara pruebas superadas.

El ejemplo usa rutas absolutas ilustrativas. El operador debe proporcionar los
perfiles privados de la instancia común, los controles reales F35/F36, el corpus
original congelado de P1, la copia inmutable I05 y su extensión vectorial, el
snapshot local del modelo y Node 24.20.0. Los directorios de logs y de credenciales
de prueba deben ser nuevos, separados entre sí y estar fuera del checkout.
Usa una ruta corta para el laboratorio: los oráculos nativos conservan sus
límites de ruta de Windows. Observa la salida de consola o el log que se añade
al final; evita mantener abiertos los JSON de progreso que se reemplazan
atómicamente mientras la batería está en ejecución.

```powershell
$Product = 'C:\Orbita\products\orbita'
$Python = 'C:\Orbita\.venv-orbita\Scripts\python.exe'
$Checker = Join-Path $Product 'agent-forensic-handoff\scripts\check.py'
& $Python -X utf8 -B $Checker --list

$CheckerInputs = @(
  '--profile', 'local-serial',
  '--lab', 'C:\T\of1',
  '--private-directory', 'C:\OrbitaPrivate\pg01-full-1',
  '--operator', 'C:\OrbitaPrivate\operator.json',
  '--runtime', 'C:\OrbitaPrivate\runtime.json',
  '--real-f35', 'C:\OrbitaPrivate\real-f35.json',
  '--real-f36', 'C:\OrbitaPrivate\real-f36.json',
  '--p1-fixture', 'C:\OrbitaOriginals\p1',
  '--i05-oracle', 'C:\OrbitaOracles\i05\products\orbita',
  '--vec-extension', 'C:\OrbitaOracles\i05\products\orbita\agent-forensic-handoff\node_modules\sqlite-vec-windows-x64\vec0.dll',
  '--model-home', 'C:\OrbitaRuntime\models',
  '--node', 'C:\OrbitaRuntime\node-v24.20.0-win-x64\node.exe',
  '--manifest', (Join-Path $Product 'SOURCE-MANIFEST.json')
)
& $Python -X utf8 -B $Checker --preflight @CheckerInputs
if ($LASTEXITCODE -ne 0) { throw 'El preflight no se completó; conservar el error' }
& $Python -X utf8 -B $Checker @CheckerInputs
if ($LASTEXITCODE -ne 0) { throw 'La batería falló; conservar el laboratorio y los recibos' }
```

La ejecución completa provisiona ámbitos de pruebas y una instalación temporal
con identidad propia. El perfil local aprobado `local-serial` ejecuta todos los
archivos Node de uno en uno y conserva la suite Python completa. Mantiene las
pruebas internas de concurrencia y sus plazos originales, con 900 segundos por
archivo y dos horas de presupuesto total de ejecución; el cierre puede requerir
tiempo adicional. El perfil `original` conserva la concurrencia de Node y los
900 segundos por suite. Ambos verifican sus cierres. El ensayo de 22 arranques
simultáneos con 60 segundos falló en este equipo y se conserva como fallo; el
perfil serial no acredita esa capacidad. Los logs y `RESULT.json` quedan en el laboratorio indicado. Los
fallos y volúmenes de prueba se conservan; el comprobador no retira los servicios
existentes. La omisión heredada de Windows permanece explícita.

La batería de la skill raíz conserva su preparación independiente descrita en
`scripts/acceptance-support/README.md` del repositorio. La entrega requiere ambas
baterías desde la copia remota, además de UI real, equivalencia, F36 y recuperación
operativa sobre las fuentes finales exactas.

## Fuentes y privacidad

La exportación excluye corpus, bases, claves, perfiles privados, dependencias,
modelos y laboratorios. `app/provenance.json` y los tres auxiliares privados de
verificación quedan fuera. La biblioteca nueva permanece vacía por defecto;
la entrada histórica de demostración utiliza una dirección reservada sin
contenido. Los ejemplos y las excepciones sintéticas de las pruebas se revisan por ruta,
contexto y hash; no contienen credenciales operativas.

`SOURCE-MANIFEST.json` identifica los bytes exportados y las transformaciones.
Git conserva el código; el respaldo recuperable conserva los datos. La retirada
de copias locales depende de las comprobaciones y lotes enumerados del mandato.
