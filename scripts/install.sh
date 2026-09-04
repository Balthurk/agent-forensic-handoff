#!/usr/bin/env sh
set -eu

target="${1:-codex}"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(dirname -- "$script_dir")

npm install -g "$repo_dir"
afh install-skill --target "$target"
afh doctor
