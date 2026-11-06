# Instalación y perfiles de ejecución

Se necesita una instancia local PostgreSQL 16, un usuario operador con permiso
para crear el rol de ejecución, Python con `app/requirements-common.txt` y los
runtimes Node y modelo local indicados expresamente. El instalador no crea ni
descarga servicios. Durante la instalación no puede haber otros clientes en la
base elegida; se rechaza la operación sin detenerlos.

La entrada `python/install-common.py` recibe por stdin un documento privado de
hasta 1 MiB con tres campos: `operator` (host, port, dbname, user, password),
`instanceId` (UUID elegido para esa instancia) y `runtimePassword` (al menos
32 caracteres). No se pasan contraseñas como argumentos. Guardar esa entrada
en un directorio privado protegido por ACL, fuera de Git y de los recibos.

La instalación crea en una transacción las 19 familias y 98 tablas de producto,
los protocolos y el recibo privado. Un fallo revierte la transacción completa.
Repetir requiere la misma identidad y contraseña; no rota credenciales ni borra
filas. Después del primer recibo se compara la estructura física completa de
las familias antes de reinstalar. No es una herramienta de reparación arbitraria
de bases modificadas. En una base anterior sin recibo verifica columnas,
catálogo, políticas, permisos y disparadores, y registra la estructura observada.

El operador puede aprovisionar una raíz mediante
`orbita_store.admin.provision_workspace(parameters, label=..., kind='personal')`,
o `kind='control'` para administración. Su resultado contiene una capacidad
secreta: se guarda únicamente en el perfil privado, nunca en un informe.
Cada perfil de ejecución tiene `schema: 1`, host, port, dbname,
`user: 'orbita_runtime'`, password, instanceId y un único elemento en `bindings`
con root (ruta absoluta virtual), workspaceId y capability. La raíz virtual
representa contenido PostgreSQL; no necesita una copia operacional en disco.
Los perfiles publicados por la importación administrada ya incluyen la nueva
capacidad: conservar el perfil publicado, no reutilizar el de staging revocado.

Para crear un control nuevo se ejecuta `node app/access-cli.mjs init ROOT` con
el perfil de ese control en `ORBITA_POSTGRES_CONFIG` y sus credenciales de cuenta
por stdin. Las cuentas y políticas importadas no se reinicializan.

Desde `app/START.ps1`, indicar `-Mode Personal` o `-Mode Managed`, `-Data ROOT`,
`-PostgresConfig PERFIL`, `-Python PYTHON`, `-Node NODE` y `-ModelHome MODELO`.
`-CheckOnly` verifica identidad, tipo de raíz, esquema, durabilidad y modelo,
y cierra sus conexiones sin arrancar un servidor. Personal utiliza por defecto
el puerto 4322; Managed utiliza 4492 y abre `/access` en loopback. `-Port` permite
elegir otro puerto. Managed exige un control inicializado y no renueva derechos
expirados. Los workers reciben únicamente su configuración delegada.

El perfil de operador no es un perfil de arranque. El launcher rechaza perfiles
con varios bindings y rechaza utilizar un control o un hijo administrado como
raíz personal. Un perfil personal puede seleccionar una subruta de su binding.
El modo de acceso se decide por el parámetro explícito y por la autoridad actual
en PostgreSQL, no por variables heredadas de otro proceso.
