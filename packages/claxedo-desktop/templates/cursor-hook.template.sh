#!/bin/bash
{{MARKER}}
set -uo pipefail

EVENT="${1:-}"
# Every exit path below must already have answered Cursor's permission hooks.
case "$EVENT" in
  "beforeShellExecution"|"beforeMCPExecution"|"PermissionRequest"|"UserActionRequired"|"QuestionRequest")
    printf '{"continue":true}\n'
    ;;
  *)
    printf '{}\n'
    ;;
esac

# ~/.cursor/hooks.json is global: every Cursor session runs this script, and
# only a Claxedo terminal tab sets CLAXEDO_TAB_ID.
[ -n "${CLAXEDO_TAB_ID:-}" ] || exit 0
[ -t 0 ] && exit 0

# Cursor supplies hook_event_name and session metadata in its JSON input.
INPUT=$(cat)
[ -n "$INPUT" ] && bash "{{NOTIFY_PATH}}" --harness=cursor "$INPUT" >/dev/null 2>&1
exit 0
