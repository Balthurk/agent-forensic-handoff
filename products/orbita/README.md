# Órbita — fuente en consolidación

Esta carpeta contiene la candidata técnica I05. Incorpora localizadores Unicode explícitos y el paso de coincidencias semánticas verificadas al contexto completo, con condiciones, revocaciones y dependencias. También cierra cada conexión HTTP interna tras la respuesta, sin reintentar mutaciones cuando se pierde una respuesta. I01–I04 siguen sellados. La acumulada local termina con 671 pruebas aprobadas y una omisión heredada; el oráculo sintético fijo conserva diez paquetes léxicos y mejora la cobertura de cláusulas del 0 al 80 %, sin falsos positivos, aunque una paráfrasis positiva continúa sin hallazgos. La cualificación utiliza Node 24.20.0 en Windows x64. Por el cambio de SQLite a 3.53.4 se repite la recuperación F36 completa: 20.035 archivos y 13.210.004.199 bytes, con ocho páginas y paquetes actual e histórico exactos. La restauración pequeña conserva la página y la instantánea en otro proceso. La reconstrucción desde Git y la UI nativa de A12 están pendientes. No hay sello I05, aceptación humana ni promoción sobre QA. I06–I10 permanecen pendientes. Los documentos QUALIFICATION anteriores conservan su alcance histórico y SOURCE-MANIFEST.json identifica cada byte exportado.

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
