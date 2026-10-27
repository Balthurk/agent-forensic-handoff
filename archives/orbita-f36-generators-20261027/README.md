# Generadores sintéticos históricos de F36

Estos siete archivos conservan los generadores y validadores que construyeron el fixture F36 scale-v4. Son fuentes históricas, con hashes y finales de línea originales, archivadas como `.source` para que no se ejecuten o descubran como pruebas por accidente. No contienen el corpus ni los valores de configuración privada.

La construcción histórica usa 1.000 conversaciones, 100 mensajes por conversación y 10 declaraciones explícitas por mensaje. El importador pasa por addSource/verifiedSources. El cargador de volumen compila cada acto, valida su payload y su envelope; su inserción masiva no mide el rendimiento de admisión interactiva. La variante de reanudación vuelve a compilar y comprobar lo ya confirmado.

Los scripts conservan rutas absolutas del laboratorio original y el pipeline crea configuración PostgreSQL con ámbito propio. **No deben ejecutarse literalmente.** Para una nueva generación se deben vincular a código cualificado y a un destino nuevo exclusivo, proporcionar configuración propia y repetir los oráculos correspondientes. Este archivo histórico no acredita que el fixture completo sea portable ni autoriza retirar sus datos todavía necesarios.

El perfil conserva páginas, versiones histórica/vigente, citas y abstenciones. El script de restauración descarta su clave efímera: su archivo cifrado es un artefacto de cualificación, no un respaldo operativo recuperable. La reconstrucción desde remoto de estas fuentes debe comprobar todos los hashes de MANIFEST.json antes de retirar una copia de código histórica.
