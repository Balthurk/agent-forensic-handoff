# I08: espera de respaldo y diagnóstico de cierre

Esta candidata I08 está pendiente de la acumulada completa y del sello. El respaldo espera de forma acotada a que terminen solicitudes, trabajos y reevaluaciones ya admitidos. La interfaz muestra la espera y permite cancelarla antes del corte exclusivo. Las importaciones registradas en PostgreSQL se identifican sin inventar una fecha o un número de archivos restaurados.

Pasaron las pruebas focales de transporte, trabajos, cancelación, reintento y cierre, y la interfaz real personal y gestionada con datos sintéticos. C01 no reprodujo una fuga en el camino actual ante pérdida del padre o EOF: se conserva el cierre global y no se añade un watchdog. La causa específica del fallo nativo histórico sigue sin establecerse. El intento focal GREEN4 conserva FAIL por una ruta inexistente del runner; sólo se reutilizan sus cuatro archivos completos, con alcance y hashes explícitos.

Se conservan todas las pruebas y sus plazos internos. Estas comprobaciones no sustituyen la acumulada ni constituyen aceptación humana. PG01 sigue cerrado funcionalmente; F36 permanece pendiente por decisión explícita, sin PASS, y el fallo original de 22 procesos/60 segundos sigue registrado. La cualificación acordada ejecuta todos los archivos localmente en serie.

La entrega I07 y las guías que siguen son antecedentes con sus propios cortes y recibos.

---

# I07: publicación concurrente e inventario de versiones

I07 entrega A03/A14 sobre las fuentes probadas de `d66d1c0ebb340a9404a8c550eb43164421db1bbf` y el espejo PostgreSQL verificado aprobado en PG01. La publicación permite escribir N04 durante el trabajo del espejo, mantiene la exclusión entre publicadores y revalida plan, generación y permisos antes del selector final. Janus externo sigue sin cualificar.

El inventario muestra versiones accesibles, referencias, leases y razones para conservarlas. Distingue versiones seleccionadas, históricas, en curso y abortadas, y retiene lo desconocido. No autoriza ni ejecuta purga; sus contadores no son una verificación exhaustiva de los objetos.

Acumulada completa desde descarga independiente: 1234 PASS, una omisión Windows heredada y cero fallos; 152 archivos y 103 comandos seriales, con todos los plazos internos. La raíz pasó 292 pruebas y una omisión; los totales se solapan y no se suman. Los dos wrappers nuevos contienen diez controles del protocolo y cinco del inventario, sin doble cómputo. Las pruebas conservan concurrencia, pérdida de autoridad y lease, crashes, replay, lectores independientes y restauración real del grafo.

La interfaz personal y gestionada mostró el inventario, sus motivos y originales con fuentes seleccionadas y teclado conservados en los flujos observados. Los lectores no ven el control de publicar y el espacio vacío no expone material del otro. La observación usa datos sintéticos y no constituye aceptación humana.

PG01 permanece cerrado funcionalmente; su recuperación operativa se reutiliza por igualdad de esquema, respaldo y cifrado. F36 sigue íntegro y pendiente por decisión explícita, sin PASS. El fallo histórico 22 procesos/60 segundos se conserva. I08–I10 están pendientes.

`QUALIFICATION-I07.json` delimita esta entrega. I06 y la guía PG01 conservadas debajo son antecedentes con sus propios recibos.

---

# I06: fuentes largas y acciones agrupadas

I06 entrega A13/A15 sobre las fuentes probadas del commit `00249358d3daa91ddf0d47b36604efffae5c725c`. Las omisiones de mensajes enteros muestran su motivo y permiten abrir el original íntegro, recorrerlo y saltar a una posición conservando la revisión exacta. Los controles existentes se agrupan por fuentes/archivo, exploración y decisiones/aprendizaje, con selección, foco y permisos conservados.

La acumulada completa desde descarga independiente pasó 1232 pruebas y una omisión Windows heredada, con 150 archivos y 101 comandos seriales. La batería de raíz pasó 292 pruebas y una omisión; tiene solapamiento con la del producto y no se suman sus totales. Se conservaron todas las pruebas y plazos internos. Cinco pruebas nuevas y 26 focales; interfaz real personal y gestionada con originales sintéticos de 93.600 bytes, navegación, descarga literal, teclado y permisos. La comprobación de accesos no acredita cada operación interna ni aceptación humana.

PG01 permanece cerrado funcionalmente y su recuperación operativa se reutiliza por igualdad de los componentes afectados. F36 sigue íntegro y pendiente como deuda de escala por decisión explícita; no se presenta como PASS. Se conserva el fallo histórico de 22 procesos/60 segundos. I07–I10 continúan pendientes.

`QUALIFICATION-I06.json` delimita la entrega. La guía heredada y los comandos reproducibles siguen debajo; sus cifras históricas corresponden al corte PG01 indicado.

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
