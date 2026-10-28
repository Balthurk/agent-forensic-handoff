# Órbita — fuente en consolidación

Esta carpeta conserva las fuentes de la entrega técnica I04: permisos coherentes en espacios administrados y reutilización limitada de procesos inactivos. I01–I04 están sellados. I04 pasó 629 pruebas acumuladas con la única omisión heredada de Windows, los flujos nativos de permisos y seis espacios, la restauración de 78 archivos en otro proceso y F36 completo: 20.035 archivos, 1.003 bases, ocho páginas y paquetes vigente e histórico exactos. Un clon nuevo del commit identificado en QUALIFICATION-I04.json se instaló con dependencias nuevas, pasó las baterías completas de la skill y Órbita y se comprobó mediante interfaz real, grafo publicado, lectura del original y controles de lector. I05–I10 permanecen pendientes. No hay aceptación humana ni promoción sobre QA. QUALIFICATION-I03.json conserva el resultado histórico de I03. SOURCE-MANIFEST.json enumera hashes de origen y exportación y la redacción de un enlace personal heredado.

Se conserva la disposición app/ y agent-forensic-handoff/ para mantener los imports existentes. Las fuentes y pruebas nuevas de I01–I04 están incluidas. El código de la skill en la raíz del repositorio tiene su propio desarrollo y no sustituye esta variante de Órbita.

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

En la raíz, `npm test` ejecuta las pruebas de la skill, incluidas las de aceptación y especificación. Sus dependencias se instalan con `npm ci` y `npm ci --prefix tools/specification`. La batería completa requiere preparar sus auxiliares y productores históricos en un laboratorio nuevo mediante `python scripts/prepare-acceptance.py --lab RUTA_ABSOLUTA_NUEVA`; después se ejecuta `npm test -- --prepared RUTA_ABSOLUTA_NUEVA/PREPARATION.json`. Las instrucciones y los hashes están en `scripts/acceptance-support/README.md` y su manifest. Esta preparación no declara pruebas superadas y no utiliza corpus real.

Para Órbita, instalar sus dependencias con `npm ci --prefix products/orbita/agent-forensic-handoff`. Crear un entorno local mediante `python -m venv .venv-orbita`, instalar requirements-tested.txt con su intérprete y usarlo como AFH_PYTHON. `.venv-orbita/` queda excluido de Git. `python products/orbita/scripts/check.py --list` enumera las tres suites sin ejecutarlas. El comando completo, con ese mismo intérprete, es `python products/orbita/scripts/check.py --lab RUTA_NUEVA_FUERA_DEL_CHECKOUT`.

La ejecución completa exige `AFH_VOLUME_PG_TEST_CONFIG`, `AFH_SEMANTIC_PG_TEST_CONFIG` y `AFH_G1_JANUS_TEST_CONFIG` apuntando a configuraciones privadas de pruebas, con sus servicios disponibles. `AFH_P1_REAL_FIXTURE` debe señalar la conversación privada congelada que necesita el oráculo P1; no se publica ni sustituye por datos sintéticos. La falta de requisitos detiene la comprobación. Los logs y el recibo quedan en el laboratorio indicado. La instalación y las baterías completas desde remoto, además de la interfaz real, pasaron para los hashes y el commit identificados en QUALIFICATION-I03.json. Las fuentes permanecieron iguales durante esas comprobaciones. Esta batería no sustituye la UI real ni la restauración operativa. En Windows se verificó una raíz temporal externa corta para AFH_TEST_ROOT, TEMP, TMP y TMPDIR, de modo que las rutas anidadas de prueba conservasen margen para los journals SQLite.

Una rama de fuentes no es un respaldo operativo de datos. La retirada de copias locales requiere, además, comprobar los hashes desde remoto, reconstrucción, consumidores y un respaldo recuperable de los datos únicos.
