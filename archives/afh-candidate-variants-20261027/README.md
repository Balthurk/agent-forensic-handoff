# Variantes históricas de fuentes AFH

Este archivo conserva 12 variantes únicas (172.400 bytes) encontradas en cinco candidatas U1/U2 de septiembre de 2026. Los objetos contienen los bytes originales, incluidos los finales de línea. MANIFEST.json relaciona cada hash con su ruta y las candidatas donde se encontró.

Las variantes no se incorporan al producto actual ni se declaran validadas. Su extensión .source evita que se descubran como pruebas, módulos o skills activos. Para recuperar un archivo, copiar el objeto indicado a su ruta original en un directorio de revisión separado y verificar SHA-256. El resto de cada candidata se debe reconstruir desde sus referencias e inventario; este paquete no acredita por sí solo esa reconstrucción completa.

Las diferencias revisadas tratan resolución de identidad nativa, correlación de invocaciones, errores de evidencia y consultas temporales. No se incluyen corpus, claves, dependencias descargadas ni directorios de ejecución. Las cinco carpetas originales permanecen intactas hasta completar la comprobación de recuperación y el lote de limpieza correspondiente.

## Reconstrucción completa de las fuentes inventariadas

RECONSTRUCTION.json mapea los 1.067 archivos de código, documentación y pruebas de las cinco candidatas (28.214.932 bytes). Conserva los casos de LF, CRLF y finales mezclados por archivo. Los objetos proceden de los commits f57332032badbfa040cc741f6d78752c60930ded y f4887f3c13221b13acaf19396aec47dbc013c13b del mismo repositorio. Si una descarga parcial no contiene el segundo, recuperarlo con git fetch origin f4887f3c13221b13acaf19396aec47dbc013c13b.

Ejecutar python archives/afh-candidate-variants-20261027/restore_sources.py --destination RUTA_ABSOLUTA_NUEVA_FUERA_DEL_CHECKOUT. El programa verifica todos los objetos y hashes antes de crear archivos y vuelve a comprobar los bytes escritos. Rechaza un destino existente. Las dependencias instaladas, archivos ignorados y estado de ejecución quedan fuera de este inventario. Recuperar fuentes no acredita su funcionamiento ni autoriza eliminar las carpetas originales.
