param(
  [ValidateSet("codex", "claude", "antigravity", "all")]
  [string]$Target = "codex"
)

$ErrorActionPreference = "Stop"
$RepoDir = Split-Path -Parent $PSScriptRoot

npm install -g $RepoDir
afh install-skill --target $Target
afh doctor
