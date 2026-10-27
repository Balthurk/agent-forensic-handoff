# Órbita — fuente en consolidación

Esta carpeta conserva las fuentes revisadas de la candidata I03. I01 e I02 tienen entrega técnica sellada. I03 ha pasado 606 pruebas acumuladas, con una omisión heredada de Windows, la interfaz local y la restauración de 924 archivos con 37 consultas exactas. Su respaldo y restauración de escala siguen en curso: I03 todavía no está terminado. I04–I10 permanecen pendientes. No hay aceptación humana ni promoción sobre QA. SOURCE-MANIFEST.json enumera los hashes de origen y exportación y la única redacción de un enlace personal heredado.

Se conserva la disposición app/ y agent-forensic-handoff/ para mantener los imports existentes. Las fuentes y pruebas nuevas de I01–I03 están incluidas. El código de la skill en la raíz del repositorio tiene su propio desarrollo y no sustituye esta variante de Órbita.

## Entorno de esta instantánea

- Node22.15 o posterior según package.json; la validación local utiliza Node24.15.
- Python 3.12 o posterior, con las capacidades de inspección de rutas requeridas, y las dependencias fijadas en requirements-tested.txt para PostgreSQL y Parquet.
- app/START.ps1 inicia la UI local. Usar una ruta de datos fuera del checkout y un puerto libre.
- AFH_PYTHON selecciona un único ejecutable, incluso con espacios en su ruta. app/PORTABILITY.md documenta los overrides especializados y sus prioridades. La UI puede arrancar, importar, consultar y abrir originales sin Codex instalado; la conexión de inferencia comunica CODEX_UNAVAILABLE cuando no existe. Las comprobaciones reales cubren los intérpretes Windows disponibles; no se afirma validación universal de plataformas.
- Las pruebas PostgreSQL, Cassandra y JanusGraph requieren los servicios y configuraciones de pruebas apropiados. Las configuraciones privadas no se incluyen. No convertir pruebas ausentes o sin configurar en aceptación.

## Conservación y privacidad

No se incluyen corpus, bases reales, claves, configuración privada, dependencias descargadas, laboratorios completos ni evidencias personales. El archivo app/provenance.json del entorno original contiene citas privadas y queda excluido; la comprobación preflight que necesita esas citas requiere una configuración propia válida. No se proporciona evidencia ficticia para satisfacerla.

Dos pruebas incluyen la misma URL sintética de UUID repetitivo y otra usa un token de ceros para verificar redacción. La revisión conserva sus bytes y documenta las tres excepciones por ruta y hash. No necesitan acceder a una conversación ni credencial real.

## Pruebas desde una copia limpia

En la raíz, `npm test` ejecuta las pruebas de la skill, incluidas las de aceptación y especificación. Sus dependencias se instalan con `npm ci` y `npm ci --prefix tools/specification`.

Para Órbita, instalar sus dependencias con `npm ci --prefix products/orbita/agent-forensic-handoff`. Crear un entorno local mediante `python -m venv .venv-orbita`, instalar requirements-tested.txt con su intérprete y usarlo como AFH_PYTHON. `.venv-orbita/` queda excluido de Git. `python products/orbita/scripts/check.py --list` enumera las tres suites sin ejecutarlas. El comando completo, con ese mismo intérprete, es `python products/orbita/scripts/check.py --lab RUTA_NUEVA_FUERA_DEL_CHECKOUT`.

La ejecución completa exige `AFH_VOLUME_PG_TEST_CONFIG`, `AFH_SEMANTIC_PG_TEST_CONFIG` y `AFH_G1_JANUS_TEST_CONFIG` apuntando a configuraciones privadas de pruebas, con sus servicios disponibles. `AFH_P1_REAL_FIXTURE` debe señalar la conversación privada congelada que necesita el oráculo P1; no se publica ni sustituye por datos sintéticos. La falta de requisitos detiene la comprobación. Los logs y el recibo quedan en el laboratorio indicado. La instalación, arranque y batería desde remoto siguen pendientes en esta instantánea; los resultados locales no se atribuyen a una descarga remota sin ejecutarlos. Esta batería no sustituye la UI real ni la restauración operativa.

Una rama de fuentes no es un respaldo operativo de datos. La retirada de copias locales requiere, además, comprobar los hashes desde remoto, reconstrucción, consumidores y un respaldo recuperable de los datos únicos.
