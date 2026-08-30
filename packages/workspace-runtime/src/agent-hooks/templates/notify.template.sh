#!/bin/bash
{{MARKER}}
# Called by CLI agents on lifecycle events

[ -z "$CLAXEDO_TAB_ID" ] && exit 0

if [ -n "$1" ]; then
  INPUT="$1"
else
  # Read from stdin when piped. Avoid blocking if invoked without stdin.
  if [ -t 0 ]; then
    INPUT="{}"
  else
    # Read one line from stdin. Use head -1 instead of read -t because
    # macOS /bin/bash 3.2 mishandles fractional timeouts on pipes,
    # causing read -t 0.1 to return empty even when data is available.
    INPUT=$(head -1 2>/dev/null || true)
    [ -z "$INPUT" ] && INPUT="{}"
  fi
fi

extract_json_field() {
  local key="$1"
  echo "$INPUT" | grep -m1 -oE "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | grep -m1 -oE '"[^"]*"$' | tr -d '"' 2>/dev/null
}

extract_json_array_last() {
  local key="$1"
  echo "$INPUT" | grep -m1 -oE "\"$key\"[[:space:]]*:[[:space:]]*\[[^]]*\]" | grep -oE '"[^"]*"' | tail -n1 | tr -d '"' 2>/dev/null
}

EVENT_TYPE=""
CODEX_TYPE=""

EVENT_TYPE=$(echo "$INPUT" | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"' 2>/dev/null)

if [ -z "$EVENT_TYPE" ]; then
  CODEX_TYPE=$(echo "$INPUT" | grep -oE '"type"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"' 2>/dev/null)
  case "$CODEX_TYPE" in
    "agent-turn-complete") EVENT_TYPE="Idle" ;;
    "agent-turn-start") EVENT_TYPE="Busy" ;;
    "permission-request"|"question-request") EVENT_TYPE="UserActionRequired" ;;
    "agent-turn-error"|"task-failed") EVENT_TYPE="Error" ;;
  esac
fi

case "$EVENT_TYPE" in
  "SessionStart"|"UserPromptSubmit"|"PostToolUse"|"BeforeAgent"|"AfterTool"|"beforeSubmitPrompt"|"sessionStart"|"userPromptSubmitted"|"postToolUse"|"Start") EVENT_TYPE="Busy" ;;
  "SessionEnd"|"AfterAgent"|"SubagentStop"|"stop"|"sessionEnd"|"Stop"|"Idle") EVENT_TYPE="Idle" ;;
  "PostToolUseFailure"|"StopFailure"|"session.error"|"sessionError"|"Error"|"Failed") EVENT_TYPE="Error" ;;
  "beforeShellExecution"|"beforeMCPExecution"|"PermissionRequest"|"QuestionRequest"|"question"|"question.asked"|"Notification") EVENT_TYPE="UserActionRequired" ;;
esac

SESSION_ID=""
for key in session_id sessionId conversation_id conversationId thread-id thread_id; do
  SESSION_ID=$(extract_json_field "$key")
  [ -n "$SESSION_ID" ] && break
done

TRANSCRIPT_PATH=""
for key in transcript_path transcriptPath; do
  TRANSCRIPT_PATH=$(extract_json_field "$key")
  [ -n "$TRANSCRIPT_PATH" ] && break
done

PROMPT=""
for key in prompt user_prompt userPrompt; do
  PROMPT=$(extract_json_field "$key")
  [ -n "$PROMPT" ] && break
done
if [ -z "$PROMPT" ]; then
  for key in input-messages input_messages inputMessages prompts; do
    PROMPT=$(extract_json_array_last "$key")
    [ -n "$PROMPT" ] && break
  done
fi

LAST_ASSISTANT_MESSAGE=""
for key in last_assistant_message last-assistant-message lastAssistantMessage assistant_message assistant-message assistantMessage; do
  LAST_ASSISTANT_MESSAGE=$(extract_json_field "$key")
  [ -n "$LAST_ASSISTANT_MESSAGE" ] && break
done

[ -n "$PROMPT" ] && PROMPT=$(printf "%s" "$PROMPT" | cut -c1-800)
[ -n "$LAST_ASSISTANT_MESSAGE" ] && LAST_ASSISTANT_MESSAGE=$(printf "%s" "$LAST_ASSISTANT_MESSAGE" | cut -c1-1500)

PROVIDER="${CLAXEDO_AGENT:-}"
if [ -z "$PROVIDER" ]; then
  for key in provider provider_id providerId agent cli; do
    PROVIDER=$(extract_json_field "$key")
    [ -n "$PROVIDER" ] && break
  done
fi
if [ -z "$PROVIDER" ] && [ -n "$CODEX_TYPE" ]; then
  PROVIDER="codex"
fi

[ -z "$EVENT_TYPE" ] && exit 0

STATE_DIR="${WORKSPACE_RUNTIME_STATE_DIR:-$HOME/.workspace-runtime/state}"
STATE_ID="${CLAXEDO_TERMINAL_ID:-$CLAXEDO_TAB_ID}"
STATE_FILE="$STATE_DIR/$STATE_ID.agent"
mkdir -p "$STATE_DIR" 2>/dev/null || true

# Simple state tracking to prevent duplicate spurious settled events
if [ "$EVENT_TYPE" = "Busy" ] || [ "$EVENT_TYPE" = "UserActionRequired" ]; then
  echo "busy" > "$STATE_FILE" 2>/dev/null || true
fi

if [ "$EVENT_TYPE" = "Idle" ] || [ "$EVENT_TYPE" = "Error" ]; then
  if [ ! -f "$STATE_FILE" ]; then
    # First settled event for this terminal - allow it (handles Codex)
    echo "idle" > "$STATE_FILE" 2>/dev/null || true
  elif grep -q "^busy$" "$STATE_FILE" 2>/dev/null; then
    # Was busy, now idle
    echo "idle" > "$STATE_FILE" 2>/dev/null || true
  else
    # Already idle - duplicate settled event
    exit 0
  fi
fi

HOOK_PORT="${CLAXEDO_SERVER_PORT:-${CLAXEDO_PORT:-{{PORT}}}}"
HOOK_URL="http://127.0.0.1:${HOOK_PORT}/api/wr/hook/agent-lifecycle"

curl -s "$HOOK_URL" \
  --request POST \
  --connect-timeout 1 \
  --max-time 2 \
  --data-urlencode "tabId=$CLAXEDO_TAB_ID" \
  --data-urlencode "terminalId=$CLAXEDO_TERMINAL_ID" \
  --data-urlencode "workspaceId=$CLAXEDO_WORKSPACE_ID" \
  --data-urlencode "eventType=$EVENT_TYPE" \
  --data-urlencode "provider=$PROVIDER" \
  --data-urlencode "sessionId=$SESSION_ID" \
  --data-urlencode "transcriptPath=$TRANSCRIPT_PATH" \
  --data-urlencode "prompt=$PROMPT" \
  --data-urlencode "lastAssistantMessage=$LAST_ASSISTANT_MESSAGE" \
  >/dev/null 2>&1 &

exit 0
