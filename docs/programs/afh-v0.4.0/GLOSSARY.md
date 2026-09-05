# Vocabulario normativo

| Término | Significado y límite |
|---|---|
| Hecho observado | Presencia de un registro o resultado verificable dentro de la adquisición. No equivale a autenticidad del productor ni verdad del texto. |
| Afirmación | Proposición de un actor sobre un sujeto/predicado/valor, con procedencia y ámbito. Puede ser falsa, corregida, contradictoria o no verificable. |
| Evidencia | Bytes adquiridos y su referencia resoluble con digest, rango, puntero y disponibilidad. Un preview, ranking o resumen no sustituye su resolución. |
| Sesión nativa | Hilo identificado por `(harness, native_id)` en el dominio de origen registrado. No es un archivo ni el `session_id` compartido de un padre. |
| Grupo/lineage | Colección versionada de sesiones y relaciones explícitas o inferidas. No cambia la identidad de sus miembros. |
| Evento lógico | Unidad normalizada con significado: solicitud de herramienta, resultado o mensaje. Puede tener varias representaciones técnicas. |
| Ocurrencia | Un acto real observado, por ejemplo una ejecución. Agrupa solicitud, resultados y representaciones de ese acto; una repetición real tiene otro ID. |
| Representación | Registro técnico concreto de un evento, como `response_item` o `item_completed`. Su referencia se conserva incluso si la presentación se deduplica. |
| Revisión de captura | Adquisición inmutable de un límite de bytes y fuentes; añadir o corregir evidencia crea otra revisión y nunca cambia una anterior. |
| Proyecto | Identidad lógica explícita e independiente de rutas y repositorios. Un alias no acredita pertenencia histórica. |
| Workspace | Contexto de trabajo con host, tipo de ruta y periodo. `projectless`, `none` y `unknown` son estados distintos. |
| Checkout | Instancia de árbol Git con repositorio/ref/HEAD observados, separada de workspace y proyecto; un worktree es un tipo. |
| Intención | Lo solicitado, perseguido o restringido: misión del programa, encargo de tarea y cambios. No acredita trabajo hecho. |
| Autoridad | Procedencia y alcance de una instrucción para una tarea. Solo se atribuye como humana con origen resoluble; el motor no crea autoridad. |
| Veracidad | Relación de una proposición sobre el mundo con evidencia pertinente; independiente de autoridad para ordenar. |
| Vigencia | Intervalo en que una decisión/relación/afirmación se aplica según evidencia. Tiempo de evento o captura no lo sustituyen. |
| Tiempo de conocimiento | Momento y revisión en que AFH incorporó o corrigió información; evita introducir conocimiento futuro. |
| Promoción | Selección versionada de una revisión de Plata para Oro, con regla, evidencia, ámbito, incertidumbre y vigencia; no crea certeza. |
| Contradicción | Incompatibilidad entre proposiciones bajo ámbito y tiempo comparables; se conservan ambas y el fundamento. |
| Sustitución/revocación | Cambio respaldado que delimita una revisión previa. La mera posterioridad no lo demuestra. |
| Cierre | Estado demostrado por criterios y validaciones pertinentes al artefacto/revisión. `exit 0`, “terminado” o una tabla verde no bastan. |
| Cobertura | Fuentes, tipos, registros, intervalos y contenido adquiridos, interpretados e indexados; con exclusiones conocidas/desconocidas. |
| Causalidad | Relación sustentada por enlace nativo o evidencia concreta; orden temporal solo describe secuencia. |

Etiquetas heredadas: `DIRECT_EVIDENCE`, `CORROBORATED`, `INFERRED`, `UNCERTAIN`, `CONTRADICTED`, `UNAVAILABLE`. `CORROBORATED` exige orígenes independientes identificados, no dos codificaciones ni diez citas. Operación, disponibilidad, cobertura y epistemología usan campos separados. `VERIFIED_PRESENT` afirma presencia comprobada, nunca verdad del contenido.

Un fin `unknown` no significa infinito. `open` significa sin final observado hasta el horizonte declarado y sigue siendo provisional. `unbounded` exige declaración expresa en la fuente. Todo resultado actual incluye `knowledge_cutoff` y `observed_through`.
