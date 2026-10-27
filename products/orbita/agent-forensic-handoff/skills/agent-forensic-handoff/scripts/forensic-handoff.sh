#!/usr/bin/env sh
set -eu

if ! command -v afh >/dev/null 2>&1; then
  echo "afh is not installed. Install with: npm install -g github:Balthurk/agent-forensic-handoff" >&2
  exit 127
fi

exec afh audit "$@"
