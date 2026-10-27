param(
    [string]$Data = (Join-Path $PSScriptRoot 'data'),
    [ValidateRange(1024,65535)][int]$Port = 4322
)
$ErrorActionPreference = 'Stop'
$env:AFH_COSMOS_DATA = [System.IO.Path]::GetFullPath($Data)
$env:AFH_COSMOS_PORT = [string]$Port
$env:AFH_COSMOS_EMPTY_LIBRARY = '1'
Set-Location -LiteralPath $PSScriptRoot
node .\server.mjs
