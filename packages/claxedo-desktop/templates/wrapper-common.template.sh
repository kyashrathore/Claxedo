#!/bin/bash
{{MARKER}}
# Claxedo wrapper for {{BINARY_NAME}}

{{FIND_REAL_BINARY}}
REAL_BIN="$(find_real_binary "{{BINARY_NAME}}")"
if [ -z "$REAL_BIN" ]; then
  echo "Claxedo: {{BINARY_NAME}} not found in PATH. Install it and ensure it is on PATH, then retry." >&2
  exit 127
fi

export CLAXEDO_AGENT="{{BINARY_NAME}}"

{{EXEC_BLOCK}}
