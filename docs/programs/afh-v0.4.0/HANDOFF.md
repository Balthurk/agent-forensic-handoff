# Entrega a implementación AFH0.4.0

## Identidad y límites

Repositorio https://github.com/Balthurk/agent-forensic-handoff.git; baseline main8560c48f1e81c16feb8f2149841d835175e0ba58, runtime0.3.0. La rama spec/afh-v0.4.0-program contiene solo especificación, tooling local y pruebas. El commit de entrega se obtiene con `git rev-parse HEAD` y se registra fuera del checkout en la coordinación existente; no se inserta su hash dentro de sí mismo. Recalcular `node specification/validate-package.mjs` y comparar snapshot_sha256 y commit con el handoff privado del coordinador antes de iniciar.

El coordinador crea la segunda tarea después de revisar el paquete completo. Se trabaja en el mismo checkout, única escritora y razonamiento high con el modelo elegido por el usuario. Esta especificación no crea ni arranca esa tarea. La autorización vigente incluye el programa completo y las correcciones técnicas aprobadas; no se pide de nuevo para decisiones rutinarias dentro del alcance. Un contrato materialmente modificado requiere revisión/evidencia aplicable. No hay autorización para tocar otros proyectos, fuentes/casos previos, instalaciones activas ni memorias globales.

## Lectura y comprobación inicial

Leer README, SCOPE, GLOSSARY, ARCHITECTURE, DATA-CONTRACT, API-CONTRACT, OPERATIONS, TESTING, registro canónico y las14 propuestas/diseños/specs/tasks. REQUIREMENTS y RECOMMENDATIONS son vistas generadas, no otra fuente manual. El schema común tipa las27 operaciones del núcleo y sus envelopes; checks relacionales y oráculos siguen obligatorios. Las recomendaciones completas son H01–H06, Q01–Q15 y N01 (esta última inferencia nueva explícita).

Instalar localmente con los comandos de README; disponer de Node22.15+ o24, SQLite del runtime, tooling OpenSpec1.12.0 y dependencias fijadas en locks. Crear cada RUN nuevo dentro de la raíz privada del programa y fijar TEMP/TMP/cache. Verificar estado Git y runtime/candidato real; baseline/RED previos son evidencia histórica, no un resultado del candidato actual. El primer paso es validar el paquete y leer el review_ref del coordinador, no modificar src.

## Ejecución secuencial

01 native-identity →02 incremental-archive →03 occurrence-ledger →04 temporal-provenance →05 governed-context →06 layered-semantics →07 contextual-retrieval →08 observable-performance →09 resident-reader →10 compatibility-matrix →11 portable-bundles →12 prospective-capture →13 continuity-evaluation →14 assured-release.

Antes de cada cambio resolver IMPLEMENTATION_READY sobre el paquete revisado, writer y predecesores. Materializar primero los harnesses CONTRACT_ONLY según TESTING; no rebajar los oráculos congelados. Conservar RED, obtener GREEN real, refactorizar y ejecutar checks afectados/baseline. Cada cambio tiene write set e interfaces definidos; modificaciones necesarias de integración se registran y revisan manteniendo ownership y sin ampliar alcance a otros sistemas. Commit local por cambio, evidencia y revisión enlazadas; el coordinador conserva la trazabilidad privada existente. Los tasks de OpenSpec permanecen sin marcar hasta ejecutar realmente su condición.

## Cierre y publicación

Los requisitos pendientes no se omiten por tiempo/esfuerzo. Plataforma/modelo/continuación/firma no disponible se informa como UNAVAILABLE y bloquea su gate; otra capacidad ya especificada puede prepararse solo respetando el orden autorizado. No etiquetar mocks, synthetics sin modelo, simuladores o health como aceptación real. Verificación de privacidad y preservación sigue requerida durante todos los cambios.

La segunda tarea puede commitear, pushear y publicar el nuevo GitHub Release cuando se satisfagan todos los gates del alcance autorizado. npm pack crea el tgz; no se incluye publicación en npm registry. Requiere matriz real de cinco targets, Node22/24, semántica local, calidad/continuaciones/escala, bundles, captura, fuzz, SBOM/attestation y smoke de instalación aislada. El draft y los assets publicados se descargan y verifican. Mantener0.3.0 e instalación activa accesibles; rollback en otro prefix. Un defecto posterior no autoriza reemplazar un tgz firmado o reescribir un tag publicado.

La entrega de esta fase es READY_FOR_COORDINATOR_REVIEW. Solo una revisión semántica satisfactoria del paquete exacto habilita SPECIFICATION_READY; la implementación y la aceptación0.4.0 todavía están pendientes.
