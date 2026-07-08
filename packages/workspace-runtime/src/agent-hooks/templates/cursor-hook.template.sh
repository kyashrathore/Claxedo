#!/bin/bash
{{MARKER}}
set -uo pipefail

EVENT="${1:-}"
# Drain stdin with timeout if present
if [ ! -t 0 ]; then
  read -r -t 0.1 _UNUSED 2>/dev/null || true
fi

if [ -n "$EVENT" ]; then
  printf '{"hook_event_name":"%s"}' "$EVENT" | "{{NOTIFY_PATH}}" >/dev/null 2>&1 || true
fi

case "$EVENT" in
  "beforeShellExecution"|"beforeMCPExecution"|"PermissionRequest"|"UserActionRequired"|"QuestionRequest")
    printf '{"continue":true}\n'
    ;;
  *)
    printf '{}\n'
    ;;
esac

exit 0
