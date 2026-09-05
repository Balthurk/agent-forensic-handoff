# Persistencia, fallos y medición

## Escritor y lectores

Un escritor por archivo local. `writer.lock` se adquiere con create-exclusive, contiene archive_id, pid, host_id, OS process-start identity, nonce aleatorio y job_id. La adquisición fallida devuelve BUSY, sin “esperar para siempre”. No se permite lock en recurso de red cuya exclusión no se haya probado. El lock se libera solo por el propietario. Un PID inexistente puede recuperarse mediante `archive.recover` con token esperado y comprobación de la identidad OS; PID vivo/reutilizado/indeterminado -> OWNER_UNVERIFIED. Nunca romper un lock por antigüedad ni heartbeat ausente solamente.

Publicar = stage de objetos/manifiestos, fsync, validar hashes y referencias, transacción SQLite única con nuevo commit_seq, commit duradero, manifiesto de revisión, y sustitución atómica de `archive.json` que avanza la revisión visible. Plata usa WAL durante escritura; lectores abren read-only y transacción fijada a `published_seq`. Filtran toda entidad/proyección por ese corte. Filas comprometidas pero todavía no publicadas son invisibles; recovery verifica y publica esa misma revisión o registra abandono, sin volver a insertar ocurrencias. Checkpoints guardan clave de config/model/parser, límites de fuente y última unidad completa, con hash. Corruptos no se reutilizan.

El fallo entre cualquier par de pasos se prueba por terminación real del proceso hijo de test, reinicio y comparación con corrida ininterrumpida. No basta lanzar una excepción simulada en el mismo proceso para demostrar durabilidad. Los fault hooks están en builds de test, no aceptan instrucciones del corpus. Al abortar, la última revisión publicada sigue resolviendo evidencia. Ningún lector ve half-built Gold o vectores de dos identidades. Discos llenos/rename bloqueado en Windows dejan staging identificado y error explícito; no reemplazan el índice sano.

`idempotency_key` de mutaciones se registra por archive+operation; misma clave y mismo request digest devuelve el receipt original. Misma clave/diferente digest -> IDEMPOTENCY_CONFLICT. Repetir ingesta con otra clave pero mismos source/config hashes produce NO_CHANGE y misma revisión; el job nuevo conserva intento/progreso sin duplicar ocurrencias. Reindex con igual identidad devuelve REUSED solo tras verificación. No hay GC automático ni eliminación de capturas antiguas. Rollback selecciona un puntero de revisión anterior verificada y registra operación nueva; no revierte/borrra historia ni modifica casos de origen.

## Límites predeterminados

| Recurso | Default / máximo explícito |
|---|---|
| Source record | 16 MiB / 64 MiB; records superiores preservados como oversized con referencia acotada, sin parseo completo |
| Fuente decodificada | 8 GiB / 64 GiB por job |
| Total job adquirido | 16 GiB / 256 GiB sujeto a reserva de disco |
| Ratio de expansión | 100 / 1000 con configuración explícita y registro; rechazar antes de agotar disco |
| Fuentes/hijos | 32 hijos / 4096; contar descubiertos y no adquiridos; universo no descubierto unknown |
| Depth JSON | 32; arrays/eventos derivados por record 1000 |
| Batch embeddings | 16 items y 16.000 caracteres; máximos 64 y 64.000, ambos activos |
| Chunk | 2000 Unicode code points, overlap 200, sin partir surrogate pairs; límite efectivo del tokenizer se registra |
| Graph | 2 hops query, 1 neighbors; hard máximo 8 hops/5000 nodos/20000 aristas |
| Consulta | 16.000 caracteres, 200 resultados, timeout 30 s; no SQL libre |
| Worker | 4 requests activas, cola 16, 1 embedding batch concurrente, idle 900 s, máximo 7200 s |
| IPC frame | 1 MiB request, 8 MiB response; evidencia mayor por lecturas acotadas |
| Spool capture | 256 MiB por segmento, 4 GiB total; al llenar, rechazar y contar pérdidas observadas |
| Bundle | 16 GiB plaintext total, 1.000.000 entradas, path 4096 UTF-8 bytes; explícitamente reducibles |

Valores inválidos se rechazan antes de crear mutaciones. Todos los límites y exclusiones aparecen en receipts. Los defaults nuevos no cambian silenciosamente límites de comandos legacy; el adaptador registra qué política aplica. Acceso a fuentes con symlink/reparse se rechaza por defecto. Paths resueltos quedan dentro de su raíz autorizada; strings con `..`, ADS, rutas absolutas de bundles y nombres reservados Windows no se materializan.

## Progreso NDJSON v1

Cada evento contiene `progress_version=1`, job_id, request_id, sequence (creciente), phase, state `STARTED|PROGRESS|COMPLETED|FAILED|CANCELLED`, elapsed_ms monotónico desde inicio, phase_elapsed_ms, completed, total nullable, unit, rate nullable, eta_ms nullable, eta_status `ESTIMATED|UNAVAILABLE`, counters y reason. Nada de comandos/transcripts/secretos. Fases: resolution, acquisition, normalization, sqlite, fts, graph, gold, semantic_prepare, model_load, embedding, projection_verify, publication, retrieval, composition, evidence_resolution. Las ausentes no se inventan; usan `NOT_APPLICABLE` en métricas finales.

Inicio/final siempre se emiten; trabajo activo largo emite a lo sumo cada 250 ms y al menos cada 2 s o cada unidad grande terminada si el runtime nativo bloquea; un supervisor externo puede emitir heartbeat de tiempo con `completed` sin cambios. Se mide event loop delay para no anunciar progreso inexistente. ETA solo con total conocido y >=5 muestras positivas durante >=5 s, EWMA alpha=0.25; si rate=0, fase cambia, retrocede contador o total cambia, reiniciar ventana y ETA UNAVAILABLE. ETA es estimación de fase, no promesa global. No sumar subfases concurrentes como wall time; registrar intervalos y critical elapsed por separado.

## Protocolo de performance y gates

Datos Reader previos son histórico acotado: 212.039,40 ms de captura, 3.804.071,84 ms de indexación, 41.673 chunks / 35.204 vectores, 1.478.940.257 bytes de caso y 2.140.110.848 bytes de pico semántico informado. Subfases no medidas siguen UNAVAILABLE. No se repite ese índice completo para obtener una cifra decorativa ni se extrapola a corpus mayor.

Se definen fixtures `scale-10k`, `scale-100k` y `scale-1m` deterministas, seed 404, tamaño medio 1024 bytes y 20% payloads idénticos con ocurrencias distintas. Un delta añade exactamente 1000 records, de los que 800 chunks normalizados son nuevos y 200 reutilizables bajo identidad igual. El generador entrega truth counts y digests antes de la medición. Configuración y hashes del dataset se congelan por corrida; no ajustar el fixture después de observar el candidato.

Gates de misma máquina frente al baseline 0.3.0 o al último punto GREEN comparable: audit p95 <=1.25x para 10k/100k; RSS <=1.25x y <=2.5 GiB durante semántica default; lexical p95 <=1.25x; semántica real recurrente/residente p95 <=0.60x del proceso nuevo con igual modelo/consulta/cobertura y además <=2 s en la máquina de referencia. El último límite es objetivo de aceptación de esa máquina, no SLA universal. Preparación inicial se informa aparte. Delta: exactamente nuevos embeddings previstos, cero llamadas al proveedor para claves idénticas y bytes nuevos de objetos <=payload único nuevo +10% metadatos medidos; prefijo leído para verificación se reporta aparte. Compression/dedup ratio = bytes lógicos/bytes físicos, acompañado por ambos numeradores y tipo de datos; no se obliga a comprimir datos incomprimibles.

Cada perfil: 2 warmups excluidos, 10 corridas medidas; percentil nearest-rank p95, mediana/min/max, intervalos brutos y reloj monotónico. Medir RSS muestreado cada 100 ms en todos los procesos propiedad del benchmark, dejando método y cota de error. Separar arranque de proceso, carga de modelo, lectura DB, búsqueda, composición y evidence. Nombrar OS cache `UNKNOWN` salvo control demostrado; “fresh process” no significa disco frío. Registrar CPU/RAM libres, host/OS/arch, Node/deps y concurrencia externa. Sin comparación válida, métrica UNAVAILABLE y gate pendiente; no comparar máquinas como si fueran iguales.

Escala sostenida (13): tres corridas 1m con dos reinicios limpios de proceso, siete deltas de 1000 records, y un crash/restart a mitad de delta; cada punto con contabilidad/recuperación exactas. No requiere días de espera artificial; fecha y secuencia de todas las corridas quedan en el historial. Cualquier salto de memoria/latencia >25% requiere explicación y gate corregido con evidencia, no edición retroactiva del umbral para pasar.
