# Legacy Codex wrapper: no native hooks.json. Use notify bridge + log watcher.

STATE_DIR="${WORKSPACE_RUNTIME_STATE_DIR:-$HOME/.workspace-runtime/state}"
STATE_ID="${CLAXEDO_TERMINAL_ID:-${CLAXEDO_TAB_ID:-}}"
PID_FILE="$STATE_DIR/$STATE_ID.codex-watch.pid"
TURN_FILE="$STATE_DIR/$STATE_ID.codex-turn"

cleanup() {
  [ -z "$STATE_ID" ] && return
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null)
    [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  rm -f "$TURN_FILE"
}

trap cleanup EXIT

mkdir -p "$STATE_DIR" 2>/dev/null || true
cleanup

# Watch ~/.codex/sessions/ for a new session log, then tail for task_started.
if [ -n "$STATE_ID" ] && [ -n "${CLAXEDO_TAB_ID:-}" ]; then
  (
    SESSION_DIR="$HOME/.codex/sessions/$(date +%Y/%m/%d)"
    mkdir -p "$SESSION_DIR" 2>/dev/null || true
    BEFORE=$(ls "$SESSION_DIR"/*.jsonl 2>/dev/null | wc -l)
    for _i in $(seq 1 60); do
      sleep 0.5
      NEWEST=$(ls -t "$SESSION_DIR"/*.jsonl 2>/dev/null | head -1)
      AFTER=$(ls "$SESSION_DIR"/*.jsonl 2>/dev/null | wc -l)
      if [ "$AFTER" -gt "$BEFORE" ] && [ -n "$NEWEST" ]; then
        exec bash "{{CODEX_WATCHER_PATH}}" "$NEWEST" "$STATE_ID"
      fi
    done
  ) >/dev/null 2>&1 &
  WATCH_PID=$!
  disown "$WATCH_PID"
  echo "$WATCH_PID" > "$PID_FILE"
fi

"$REAL_BIN" -c 'notify=["bash","{{CODEX_NOTIFY_PATH}}"]' "$@"
EXIT_CODE=$?
exit $EXIT_CODE
