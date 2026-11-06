# Regresión de la versión PostgreSQL

`check.py` descubre y ejecuta las baterías de núcleo, aplicación y Python de esta
copia del producto. Utiliza una base PostgreSQL común de pruebas, espacios nuevos
por archivo Node y los casos privados requeridos por las comprobaciones
históricas. Las pruebas completas necesitan esos datos; no se sustituyen por
casos sintéticos ni se omiten si faltan.

La aplicación se inicia siguiendo [POSTGRES-START.md](../../app/POSTGRES-START.md).
Este comprobador es para verificar una instalación de desarrollo o una
reconstrucción de las fuentes.

## Entradas

Se requieren Windows, Python 3.12 o posterior con las dependencias del producto,
Node, Docker Desktop y la imagen PostgreSQL fijada por el producto ya disponible
localmente. La cualificación utiliza Python 3.12.10 y Node 24.20.0. No se descargan
imágenes ni modelos durante esta comprobación.

| Argumento | Contenido |
|---|---|
| `--operator` | Archivo privado del operador de una base común de pruebas ya instalada. Las pruebas crean espacios y familias auxiliares en ella. |
| `--runtime` | Perfil de ejecución de esa misma instancia, con el rol `orbita_runtime`. |
| `--private-directory` | Carpeta nueva bajo un directorio privado protegido, fuera del código y de los logs. Recibirá las credenciales de las pruebas. |
| `--lab` | Carpeta nueva de logs y recibos, fuera del código y de la carpeta privada. |
| `--real-f35`, `--real-f36` | Perfiles privados de los controles históricos F35/F36 publicados. Las pruebas de arranque comparan sus filas antes y después. |
| `--p1-fixture` | Directorio nativo del caso privado requerido por la prueba P1. |
| `--i05-oracle` | Producto I05 conservado que actúa como oráculo de importación. |
| `--vec-extension` | Extensión SQLite vec del entorno del oráculo histórico; el producto operativo sigue usando PostgreSQL. |
| `--model-home` | Snapshot local del modelo indicado en la guía de arranque. |
| `--node` | Ruta absoluta al ejecutable Node. |
| `--profile` | `original` conserva la concurrencia predeterminada de Node; `local-serial` ejecuta un archivo Node por vez y la suite Python completa. |
| `--manifest` | Opcional: manifiesto de fuentes revisado. Por defecto, `SOURCE-MANIFEST.json` en la raíz del producto. |

La base común de pruebas debe estar sin clientes de aplicación. Se comprueban la
identidad de la instancia, la durabilidad y los hashes del código. Se requieren
al menos 8 GiB libres de RAM y 60 GiB de disco al inicio. El perfil `original`
conserva 900 segundos por batería y la concurrencia predeterminada de Node. El
perfil `local-serial` conserva todas las pruebas, concurrencias internas y plazos
internos; aplica 900 segundos por archivo Node o suite Python y 7200 segundos al
conjunto. El cierre puede requerir tiempo adicional. El ensayo de 22 arranques
simultáneos con 60 segundos permanece como fallo; el perfil serial no acredita
esa capacidad.

Usa una ruta corta para `--lab`, por ejemplo `C:\T\of1`, por los límites de
ruta de los oráculos nativos de Windows. Durante la ejecución observa la salida
de consola o el log que se añade al final. No mantengas abiertos los JSON de
progreso: se reemplazan atómicamente.

## Ejecución

Para ver los archivos descubiertos, sin conectar a servicios:

```powershell
$Product = 'C:\Orbita\products\orbita'
$Python = 'C:\Orbita\.venv-orbita\Scripts\python.exe'
$Check = Join-Path $Product 'agent-forensic-handoff\scripts\check.py'
& $Python -X utf8 -B $Check --list
```

Ejemplo de comprobación previa; todas las rutas son ejemplos que debe sustituir
el operador por sus entradas privadas:

```powershell
$Inputs = @(
  '--profile', 'local-serial',
  '--lab', 'C:\T\of1',
  '--private-directory', 'D:\OrbitaPrivate\check-new',
  '--operator', 'D:\OrbitaPrivate\test-operator.json',
  '--runtime', 'D:\OrbitaPrivate\test-runtime.json',
  '--real-f35', 'D:\OrbitaPrivate\published-f35.json',
  '--real-f36', 'D:\OrbitaPrivate\published-f36.json',
  '--p1-fixture', 'D:\OrbitaInputs\p1',
  '--i05-oracle', 'D:\OrbitaInputs\i05\products\orbita',
  '--vec-extension', 'D:\OrbitaInputs\i05\products\orbita\agent-forensic-handoff\node_modules\sqlite-vec-windows-x64\vec0.dll',
  '--model-home', 'D:\OrbitaRuntime\models',
  '--node', 'D:\OrbitaRuntime\node-v24.20.0-win-x64\node.exe'
)
& $Python -X utf8 -B $Check @Inputs --preflight
```

La comprobación previa no crea los espacios ni inicia servicios. Para ejecutar
las tres baterías se usa el mismo comando sin `--preflight`.

El comprobador crea un servicio PostgreSQL adicional para las pruebas de
instalación y respaldo. Usa un volumen nuevo, un puerto loopback nuevo y una
identidad propia registrada antes de arrancarlo. Al terminar verifica sus
consumidores y detiene ese servicio. Conserva el volumen y toda la evidencia,
incluidos los fallos. No retira servicios ni datos existentes.

## Lectura del resultado

`RESULT.json` recoge los códigos de salida, los totales completos, las omisiones,
los hashes de logs y fuentes, y los cierres de conexiones. El núcleo conserva
una única omisión histórica de Windows, identificada por su nombre. Una salida
parcial, un plazo agotado o una omisión nueva produce un fallo.

`PASS_FULL_DISCOVERED_CUMULATIVE` sólo acredita esas tres baterías. La revisión de
la interfaz, F36 a escala completa, la custodia operativa y la aceptación del
usuario se documentan por separado.
