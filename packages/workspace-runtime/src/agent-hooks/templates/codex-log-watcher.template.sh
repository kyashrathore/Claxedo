#!/bin/bash
{{MARKER}}
set -uo pipefail

LOG_PATH="${1:-}"
STATE_ID="${2:-${CLAXEDO_TERMINAL_ID:-$CLAXEDO_TAB_ID}}"

[ -z "$LOG_PATH" ] && exit 0
[ -z "$STATE_ID" ] && exit 0

STATE_DIR="$HOME/.claxedo/state"
TURN_FILE="$STATE_DIR/$STATE_ID.codex-turn"
mkdir -p "$STATE_DIR" 2>/dev/null || true
touch "$LOG_PATH" 2>/dev/null || true

# Initial backward scan: check if there's already an active turn
# (task_started after the last task_complete in the log).
LAST_STARTED=$(tail -n 50 "$LOG_PATH" 2>/dev/null | grep -n '"task_started"' | tail -1 | cut -d: -f1)
LAST_COMPLETE=$(tail -n 50 "$LOG_PATH" 2>/dev/null | grep -n '"task_complete"' | tail -1 | cut -d: -f1)
if [ -n "$LAST_STARTED" ] && { [ -z "$LAST_COMPLETE" ] || [ "$LAST_STARTED" -gt "$LAST_COMPLETE" ]; }; then
  echo '{"hook_event_name":"Busy"}' | "{{CODEX_NOTIFY_PATH}}" 2>/dev/null || true
fi

tail -n0 -F "$LOG_PATH" 2>/dev/null | while IFS= read -r line; do
  case "$line" in
    *'"type":"task_started"'*|*'"type": "task_started"'*)
      turn=$(echo "$line" | grep -oE '"turn_id"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"' 2>/dev/null)
      if [ -n "$turn" ] && [ -f "$TURN_FILE" ] && grep -q "^$turn$" "$TURN_FILE" 2>/dev/null; then
        continue
      fi
      [ -n "$turn" ] && echo "$turn" > "$TURN_FILE"
      echo '{"hook_event_name":"Busy"}' | "{{CODEX_NOTIFY_PATH}}" 2>/dev/null || true
      ;;
  esac
done

exit 0
