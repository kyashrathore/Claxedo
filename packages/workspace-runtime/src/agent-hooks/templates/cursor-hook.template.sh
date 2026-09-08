#!/bin/bash
{{MARKER}}
set -uo pipefail

EVENT="${1:-}"
# Cursor supplies hook_event_name and session metadata in its JSON input.
# Forward it intact; the argument controls only the provider reply below.
if [ ! -t 0 ]; then
  INPUT=$(cat)
  if [ -n "$INPUT" ]; then
    bash "{{NOTIFY_PATH}}" "$INPUT" >/dev/null 2>&1 || true
  fi
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
