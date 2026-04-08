# Codex exposes completion notifications via notify.
# For per-prompt Start notifications and permission requests, watch the TUI
# session log for task_started/exec_command_begin and *_approval_request events.
if [ -n "$CLAXEDO_TAB_ID" ] && [ -f "{{CODEX_NOTIFY_PATH}}" ]; then
  export CODEX_TUI_RECORD_SESSION=1
  if [ -z "$CODEX_TUI_SESSION_LOG_PATH" ]; then
    _claxedo_codex_ts="$(date +%s 2>/dev/null || echo "$$")"
    export CODEX_TUI_SESSION_LOG_PATH="${TMPDIR:-/tmp}/claxedo-codex-session-$$_${_claxedo_codex_ts}.jsonl"
  fi

  (
    _claxedo_log="$CODEX_TUI_SESSION_LOG_PATH"
    _claxedo_notify="{{CODEX_NOTIFY_PATH}}"
    _claxedo_last_turn_id=""
    _claxedo_last_approval_id=""
    _claxedo_last_exec_call_id=""
    _claxedo_approval_fallback_seq=0

    _claxedo_emit_event() {
      _claxedo_event="$1"
      _claxedo_payload=$(printf '{"hook_event_name":"%s"}' "$_claxedo_event")
      bash "$_claxedo_notify" "$_claxedo_payload" >/dev/null 2>&1 || true
    }

    # Wait briefly for codex to create the session log.
    _claxedo_i=0
    while [ ! -f "$_claxedo_log" ] && [ "$_claxedo_i" -lt 200 ]; do
      _claxedo_i=$((_claxedo_i + 1))
      sleep 0.05
    done
    if [ ! -f "$_claxedo_log" ]; then
      exit 0
    fi

    tail -n 0 -F "$_claxedo_log" 2>/dev/null | while IFS= read -r _claxedo_line; do
      case "$_claxedo_line" in
        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"task_started"'*)
          _claxedo_turn_id=$(printf '%s\n' "$_claxedo_line" | awk -F'"turn_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')
          [ -n "$_claxedo_turn_id" ] || _claxedo_turn_id="task_started"
          if [ "$_claxedo_turn_id" != "$_claxedo_last_turn_id" ]; then
            _claxedo_last_turn_id="$_claxedo_turn_id"
            _claxedo_emit_event "Start"
          fi
          ;;
        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"'*'_approval_request"'*)
          _claxedo_approval_id=$(printf '%s\n' "$_claxedo_line" | awk -F'"id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')
          [ -n "$_claxedo_approval_id" ] || _claxedo_approval_id=$(printf '%s\n' "$_claxedo_line" | awk -F'"approval_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')
          [ -n "$_claxedo_approval_id" ] || _claxedo_approval_id=$(printf '%s\n' "$_claxedo_line" | awk -F'"call_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')
          if [ -z "$_claxedo_approval_id" ]; then
            _claxedo_approval_fallback_seq=$((_claxedo_approval_fallback_seq + 1))
            _claxedo_approval_id="approval_request_${_claxedo_approval_fallback_seq}"
          fi
          if [ "$_claxedo_approval_id" != "$_claxedo_last_approval_id" ]; then
            _claxedo_last_approval_id="$_claxedo_approval_id"
            _claxedo_emit_event "PermissionRequest"
          fi
          ;;
        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"exec_command_begin"'*)
          _claxedo_exec_call_id=$(printf '%s\n' "$_claxedo_line" | awk -F'"call_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')
          if [ -n "$_claxedo_exec_call_id" ]; then
            if [ "$_claxedo_exec_call_id" != "$_claxedo_last_exec_call_id" ]; then
              _claxedo_last_exec_call_id="$_claxedo_exec_call_id"
              _claxedo_emit_event "Start"
            fi
          else
            _claxedo_emit_event "Start"
          fi
          ;;
      esac
    done
  ) &
  CLAXEDO_CODEX_START_WATCHER_PID=$!
fi

"$REAL_BIN" -c 'notify=["bash","{{CODEX_NOTIFY_PATH}}"]' "$@"
CLAXEDO_CODEX_STATUS=$?

if [ -n "$CLAXEDO_CODEX_START_WATCHER_PID" ]; then
  kill "$CLAXEDO_CODEX_START_WATCHER_PID" >/dev/null 2>&1 || true
  wait "$CLAXEDO_CODEX_START_WATCHER_PID" 2>/dev/null || true
fi

exit "$CLAXEDO_CODEX_STATUS"
