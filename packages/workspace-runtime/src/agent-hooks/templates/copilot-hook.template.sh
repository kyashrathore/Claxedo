#!/bin/bash
{{MARKER}}
set -uo pipefail

EVENT="${1:-}"
# Copilot runs this project hook in every session; only a Claxedo tab reports status.
[ -n "${CLAXEDO_TAB_ID:-}" ] || { printf '{}\n'; exit 0; }
# Drain stdin with timeout if present
if [ ! -t 0 ]; then
  read -r -t 0.1 _UNUSED 2>/dev/null || true
fi

if [ -n "$EVENT" ]; then
  printf '{"hook_event_name":"%s"}' "$EVENT" | "{{NOTIFY_PATH}}" --harness=copilot >/dev/null 2>&1 || true
fi

printf '{}\n'
exit 0
