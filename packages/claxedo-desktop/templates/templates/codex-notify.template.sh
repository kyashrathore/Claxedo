#!/bin/bash
{{MARKER}}
set -uo pipefail

if [ -n "$1" ]; then
  INPUT="$1"
else
  if [ -t 0 ]; then
    INPUT="{}"
  else
    # Use read -t 1 instead of cat to avoid blocking when codex holds the pipe open.
    IFS= read -r -t 1 INPUT 2>/dev/null || true
    [ -z "$INPUT" ] && INPUT="{}"
  fi
fi

# Fallback: start the log watcher from here if the wrapper's poller didn't.
if [ -n "${CLAXEDO_TAB_ID:-}" ] && [ -n "${CODEX_TUI_SESSION_LOG_PATH:-}" ]; then
  STATE_DIR="$HOME/.claxedo/state"
  STATE_ID="${CLAXEDO_TERMINAL_ID:-$CLAXEDO_TAB_ID}"
  PID_FILE="$STATE_DIR/$STATE_ID.codex-watch.pid"
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null)
    if ! { [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; }; then
      rm -f "$PID_FILE"
    fi
  fi
  if [ ! -f "$PID_FILE" ]; then
    mkdir -p "$STATE_DIR" 2>/dev/null || true
    bash "{{CODEX_WATCHER_PATH}}" "$CODEX_TUI_SESSION_LOG_PATH" "$STATE_ID" >/dev/null 2>&1 &
    echo $! > "$PID_FILE"
  fi
fi

exec "{{CODEX_NOTIFY_PATH}}" "$INPUT"
