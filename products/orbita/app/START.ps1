param(
    [ValidateSet('Personal','Managed')][string]$Mode = 'Personal',
    [string]$Data = (Join-Path $PSScriptRoot 'data'),
    [ValidateRange(1024,65535)][int]$Port = 4322,
    [string]$PostgresConfig = $env:ORBITA_POSTGRES_CONFIG,
    [string]$Python = $env:ORBITA_POSTGRES_PYTHON,
    [string]$Node = $env:AFH_NODE,
    [string]$ModelHome = $env:AFH_MODEL_HOME,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$Mode=if($Mode -eq 'Managed'){'Managed'}else{'Personal'}
if(-not $PSBoundParameters.ContainsKey('Port') -and $Mode -eq 'Managed'){$Port=4492}
function Test-Absolute([string]$Value){return $Value -match '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+[\\/]?)'}
foreach($entry in @(@('PostgresConfig',$PostgresConfig),@('Python',$Python))){
    if(-not $entry[1] -or -not (Test-Absolute $entry[1]) -or -not (Test-Path -LiteralPath $entry[1] -PathType Leaf)){throw ('START_EXPLICIT_'+$entry[0].ToUpper()+'_REQUIRED')}
}
if(-not $ModelHome -or -not (Test-Absolute $ModelHome) -or -not (Test-Path -LiteralPath $ModelHome -PathType Container)){throw 'START_EXPLICIT_MODEL_RUNTIME_REQUIRED'}
if($env:ORBITA_POSTGRES_BINDING){throw 'START_REQUIRES_FILE_CONFIGURATION'}
if(-not $Node){$Node=(Get-Command node.exe -CommandType Application -ErrorAction Stop).Source}
if(-not (Test-Absolute $Node) -or -not(Test-Path -LiteralPath $Node -PathType Leaf)){throw 'START_NODE_RUNTIME_REQUIRED'}
$nodeVersion=& $Node --version
if($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24){throw 'START_NODE_24_REQUIRED'}
$env:ORBITA_POSTGRES_CONFIG=[IO.Path]::GetFullPath($PostgresConfig)
$env:ORBITA_POSTGRES_PYTHON=[IO.Path]::GetFullPath($Python)
$env:AFH_PYTHON=$env:ORBITA_POSTGRES_PYTHON
$env:AFH_MODEL_HOME=[IO.Path]::GetFullPath($ModelHome)
$env:AFH_COSMOS_DATA = [System.IO.Path]::GetFullPath($Data)
$env:AFH_COSMOS_PORT = [string]$Port
$env:AFH_COSMOS_EMPTY_LIBRARY = '1'
$env:AFH_MANAGED=$null
$env:AFH_PRIVATE_TOKEN=$null
$env:AFH_ACCESS_URL=$null
$env:AFH_ACCESS_ROOT=$null
$env:AFH_ACCESS_PORT=$null
Set-Location -LiteralPath $PSScriptRoot
& $Node .\startup-probe.mjs $Mode $env:AFH_COSMOS_DATA
if($LASTEXITCODE -ne 0){throw 'START_COMMON_RUNTIME_NOT_READY'}
if($CheckOnly){return}
if($Mode -eq 'Managed'){
    $env:AFH_ACCESS_ROOT=$env:AFH_COSMOS_DATA
    $env:AFH_ACCESS_PORT=[string]$Port
    & $Node .\access-server.mjs
}else{
    & $Node .\server.mjs
}
if($LASTEXITCODE -ne 0){throw 'ORBITA_SERVER_FAILED'}
