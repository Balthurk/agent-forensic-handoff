# Alcance autorizado y origen de requisitos

## Inclusión completa

Esta release revisa H01–H06, Q01–Q15 y N01. Se conserva lo correctamente implementado y probado; se integra lo solapado en una capacidad mejor de este programa. No se excluye una mejora pendiente por prioridad, esfuerzo o tamaño. `RECOMMENDATIONS.md` contiene 22 filas. H04 y H03 tienen base implementada y ampliación pendiente; no están resueltos por la mera existencia de un adaptador o grafo.

La evidencia de origen enumera 4.062 JSONL locales, 60 candidatos y 12 conversaciones/sesiones clasificadas, con siete sesiones que invocaron AFH realmente. El inventario no acredita cobertura remota, eliminada o universal. H01–Q15 son recomendaciones históricas deduplicadas; N01 es una inferencia nueva etiquetada. Las precisiones actuales de identidad móvil, temporalidad, medallón e intenciones encadenadas se atribuyen al encargo del programa.

## Límites de trabajo

Esta fase crea OpenSpec, contratos, fixtures sintéticos, tests y verificadores. No modifica `src/`, `bin/`, instalación activa ni casos antiguos. La segunda tarea usa el mismo checkout y ejecuta 01–14 secuencialmente después de revisión del coordinador. Puede implementar, commitear, pushear y publicar cuando todos los gates del alcance estén satisfechos. No requiere otra aprobación humana para decisiones rutinarias ni correcciones de este paquete. La revisión del coordinador es la revisión de contratos solicitada, no una aprobación humana inventada.

El proyecto padre no se convierte en repositorio Git. Coordinación y referencias privadas quedan fuera del checkout. Solo fixtures sintéticos o redactados y revisados entran en Git/CI; casos, claves, rollouts y derivados reales son privados. Originales y checkouts de referencia son de solo lectura. Herramientas de desarrollo se instalan localmente. Ninguna prueba histórica reejecuta comandos o prompts adquiridos.

## Límites del producto

No promete rescatar bytes truncados/no persistidos, actividad inaccesible, razonamiento privado o efectos desconocidos. No impone MCP, tres servidores, base por proyecto, vector store externo o plataforma de gobernanza. No importa gates de proyectos auditados ni convierte instrucciones históricas en órdenes vigentes.

Captura prospectiva, worker y transporte cifrado son capacidades de esta release de uso opcional. Eso no autoriza omitir su construcción/prueba. Una plataforma no disponible para medir queda `UNAVAILABLE`; el gate de publicación espera evidencia, sin simular PASS.

## Decisiones resueltas

SQLite sigue como núcleo determinista; archivo local por dominio de acceso; partición física solo por acceso o límites medidos. Schema 4 en archivos nuevos. CLI/API legado preservado. Semántica explícita de Plata y Oro. Servicio IPC local opcional sin HTTP público. Cifrado estándar detallado en 11. Captura futura mediante hook opt-in e importadores documentados en 12. Objetivo 0.4.0 y publicación GitHub comprobada; npm pack construye el tgz; no se incluye publicar en npm registry. La consulta del canal actual no encontró ese paquete en npm.
