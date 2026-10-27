# Órbita — fuente en consolidación

Esta carpeta conserva una instantánea revisable del código de Órbita durante I02. No es una publicación de producto aceptado. I01 está cerrado; I02 requiere su acumulada completa y sello, y I03–I10 siguen pendientes. SOURCE-MANIFEST.json enumera cada archivo, los hashes de origen y de esta copia, y la única redacción de un enlace personal heredado.

Se conserva la disposición app/ y agent-forensic-handoff/ para mantener los imports existentes. Las fuentes y pruebas nuevas de I01/I02 están incluidas. El código de la skill en la raíz del repositorio tiene su propio desarrollo y no sustituye esta variante de Órbita.

## Entorno de esta instantánea

- Node22.15 o posterior según package.json; la validación local utiliza Node24.15.
- Python y las dependencias fijadas en requirements-tested.txt para PostgreSQL y Parquet.
- app/START.ps1 inicia la UI local. Usar una ruta de datos fuera del checkout y un puerto libre.
- El arranque actual depende de la instalación local de Codex y algunas rutas Python todavía requieren el entorno de desarrollo original. La eliminación de esas dependencias está prevista en I03; esta instantánea no afirma portabilidad ya resuelta.
- Las pruebas PostgreSQL, Cassandra y JanusGraph requieren los servicios y configuraciones de pruebas apropiados. Las configuraciones privadas no se incluyen. No convertir pruebas ausentes o sin configurar en aceptación.

## Conservación y privacidad

No se incluyen corpus, bases reales, claves, configuración privada, dependencias descargadas, laboratorios completos ni evidencias personales. El archivo app/provenance.json del entorno original contiene citas privadas y queda excluido; la comprobación preflight que necesita esas citas requiere una configuración propia válida. No se proporciona evidencia ficticia para satisfacerla.

Las pruebas incluyen una URL y un token sintéticos explícitos para verificar importación y redacción. La revisión conserva sus bytes y documenta estas dos excepciones precisas.

## Pruebas desde una copia limpia

En la raíz, `npm test` ejecuta las pruebas de la skill, incluidas las de aceptación y especificación. Sus dependencias se instalan con `npm ci` y `npm ci --prefix tools/specification`.

Para Órbita, instalar sus dependencias con `npm ci --prefix products/orbita/agent-forensic-handoff` y las de Python con `python -m pip install -r products/orbita/requirements-tested.txt`. `python products/orbita/scripts/check.py --list` enumera las tres suites sin ejecutarlas. El comando completo es `python products/orbita/scripts/check.py --lab RUTA_NUEVA_FUERA_DEL_CHECKOUT`.

La ejecución completa exige `AFH_VOLUME_PG_TEST_CONFIG`, `AFH_SEMANTIC_PG_TEST_CONFIG` y `AFH_G1_JANUS_TEST_CONFIG` apuntando a configuraciones privadas de pruebas, con sus servicios disponibles. La falta de configuración detiene la comprobación; no omite esas pruebas. Los logs y el recibo quedan en el laboratorio indicado. Esta batería no sustituye la UI real ni la restauración operativa.

Una rama de fuentes no es un respaldo operativo de datos. La retirada de copias locales requiere, además, comprobar los hashes desde remoto, reconstrucción, consumidores y un respaldo recuperable de los datos únicos.
