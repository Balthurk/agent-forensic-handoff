# Arranque e intérpretes

Órbita puede arrancar, importar documentos, consultar sus fuentes y abrir originales sin una instalación local de Codex. La conexión de inferencia se comprueba al solicitar su estado o una inferencia. Si falta la instalación, el estado es `CODEX_UNAVAILABLE`; no se crea un trabajo de inferencia. Un espacio administrado mantiene su rechazo explícito hasta disponer de una conexión propia.

La aplicación requiere **Python 3.12 o posterior** con las capacidades de inspección de rutas de esa versión. Los almacenes de volumen y semánticos comprueban este requisito antes de abrir o crear sus bases. Detectan enlaces simbólicos, junctions incluso rotas, otros reparse points de Windows y archivos con varios enlaces físicos. Una capacidad ausente o un error de inspección no convierte la ruta en segura. Estas comprobaciones conservan la política existente de rutas ordinarias; no prometen protección frente a cambios concurrentes de rutas por otro proceso.

`AFH_PYTHON` selecciona el intérprete común. Cada valor representa **un único ejecutable**, también cuando su ruta contiene espacios. No se añaden argumentos al valor ni se ejecuta mediante un shell. Los overrides especializados tienen prioridad:

| Consumidor | Prioridad antes de AFH_PYTHON |
|---|---|
| Volumen | AFH_VOLUME_PYTHON |
| Almacenamiento semántico | AFH_SEMANTIC_PYTHON, AFH_VOLUME_PYTHON |
| Puente semántico con PostgreSQL | AFH_SEMANTIC_PYTHON, AFH_VOLUME_PYTHON |
| Puente semántico local | Ninguno |
| Jev | AFH_JEV_PYTHON |
| Compatibilidad SQLite | AFH_SQLITE_PYTHON |

El valor predeterminado es `python` en Windows y `python3` en otros sistemas. Las dependencias de cada backend deben estar instaladas en el intérprete elegido. La prueba de una versión/capacidad simulada se informa por separado de una ejecución real de esa versión.

Las pruebas nuevas usan `AFH_TEST_ROOT` o el directorio temporal del sistema y comprueban su carpeta propia antes de limpiarla. La prueba P1 admite `AFH_P1_REAL_FIXTURE`, una ruta al corpus privado real previamente verificado; conserva la ruta heredada como alternativa y todas sus aserciones. Ese corpus no se publica en Git. Para arrancar con datos fuera del código, se pasa una ruta explícita a `START.ps1 -Data <ruta> -Port <puerto>`.

La corrección del separador `·` sólo afecta al transcript derivado; la captura original conserva sus bytes y hash. La ruta HTTP `/incremental-web.mjs` conserva el mismo recurso tras retirar la clave duplicada.
