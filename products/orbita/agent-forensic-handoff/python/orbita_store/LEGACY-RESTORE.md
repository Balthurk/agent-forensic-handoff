# Conversión explícita de copias v1

`orbita_store.legacy_restore` convierte una copia `ORBITA-BACKUP-01` al
almacenamiento común. La restauración v2 de la aplicación conserva su contrato:
no detecta v1 para activar una ruta alternativa de forma implícita.

La entrada requiere el SHA256 del ciphertext, contraseña, identidad de operación
UUID, destino nuevo, staging nuevo, Node absoluto y un directorio privado local
para la frontera SQLite. La configuración es la de runtime, con una capacidad
limitada al espacio elegido; no se entrega la credencial del operador a Node.

1. Un handle Windows impide escribir o borrar el ciphertext nativo durante la
   lectura; un ciphertext en PostgreSQL permanece fijado a su versión inmutable.
   La contraseña viaja por stdin de un proceso Node propio, nunca por argv ni su
   entorno inicial. El plaintext se escribe en un objeto incompleto de PG. Sólo
   se publica su nombre tras comprobar GCM, hash completo, longitud y cierre.
2. Después de autenticar se crea `orbita-v1-<UUID>` bajo el directorio privado.
   Antes de escribir plaintext se establece y comprueba una DACL que permite al
   usuario actual, SYSTEM y administradores. El extractor rechaza rutas que
   escapen, alias de Windows, nombres duplicados, padres ausentes, JSON no
   canónico, límites excedidos, hashes incorrectos y datos tras el frame final.
3. El plan legado convierte SQLite contra esquemas instalados; no ejecuta el
   DDL del archivo en PostgreSQL. WAL/journal no vacíos requieren un corte
   coherente y producen un error. Los originales quedan custodiados como bytes;
   las autoridades antiguas no se restauran. Se conservan directorios vacíos.
4. Un lector nuevo compara todos los objetos, custodia, derivaciones y tablas
   tipadas. Otro proceso de la aplicación verifica la biblioteca y la integridad
   de los casos. El contexto del ciphertext queda ligado al hash del plan.
5. El control privado con `automaticWork=false` y `externalAccess=false` y el
   movimiento al destino se confirman en una transacción. Una lectura nueva
   comprueba el resultado. La limpieza nativa sólo recorre las identidades que
   creó esta operación, sin borrado recursivo de rutas desconocidas.

La API Python es `restore_legacy(...)`. La CLI acepta `restore` y `status`:

```text
python -m orbita_store.legacy_restore restore
  --archive <ruta absoluta> --archive-sha256 <sha256>
  --destination <destino PG nuevo> --stage <staging PG nuevo>
  --operation-id <uuid> --private-parent <directorio privado existente>
  --node <node.exe absoluto> --archive-storage native
```

La orden se ejecuta en una sola línea y recibe un documento JSON privado con
únicamente `password` por stdin. No incluirlo en comandos, logs o recibos. Usa
`ORBITA_POSTGRES_CONFIG` o `ORBITA_POSTGRES_BINDING`, con la configuración normal
de runtime. Para ciphertext en PG, seleccionar `postgresql-common`.

Ante una interrupción o pérdida de respuesta, no repetir automáticamente:

```text
python -m orbita_store.legacy_restore status
  --destination <destino> --operation-id <uuid> --archive-sha256 <sha256>
```

`NOT_PUBLISHED` distingue ausencia de publicación. `PUBLISHED_PAUSED` confirma
que el control y el recibo de esa operación coinciden. Una activación explícita
posterior se muestra como `PUBLISHED_EXPLICITLY_ACTIVATED`. Un UUID o hash ajeno
se rechaza. El staging PG y cualquier directorio privado dejado por la muerte
del proceso se conservan para inspección y limpieza enumerada; no se barren.

Límites predeterminados: 50.000 archivos, 50 GiB de contenido, frames de 8192
bytes y seis horas para la operación. La validación de aplicación tiene un
límite propio de 600 segundos, dentro del plazo restante. Un fallo después de
confirmar puede requerir consultar `status`, aunque no se haya devuelto éxito.

La cualificación cubre el escritor I05 original con SQLite y datos ficticios,
fuente nativa y PG, entradas hostiles y muerte real antes/después de confirmar.
No acredita el descifrado de copias históricas cuya contraseña no esté
disponible, una acumulada integral, la escala F36 o aceptación humana.
