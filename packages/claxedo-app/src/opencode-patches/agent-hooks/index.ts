/**
 * Agent Hooks Setup (Server-side)
 *
 * Creates wrapper scripts and shell integration for CLI agent lifecycle hooks.
 * This runs on the OpenCode server which has filesystem access.
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { Log } from "@/util/log"

const log = Log.create({ service: "agent-hooks" })

// Directories
const CLAXEDO_DIR = path.join(os.homedir(), ".claxedo")
const BIN_DIR = path.join(CLAXEDO_DIR, "bin")
const HOOKS_DIR = path.join(CLAXEDO_DIR, "hooks")
const SHELL_DIR = path.join(CLAXEDO_DIR, "shell")
const OPENCODE_CONFIG_DIR = path.join(CLAXEDO_DIR, "opencode-config")
const OPENCODE_PLUGIN_DIR = path.join(OPENCODE_CONFIG_DIR, "plugin")

const OPENCODE_AGENT_DIR = path.join(OPENCODE_CONFIG_DIR, "agent")

// Markers
const WRAPPER_MARKER = "# Claxedo agent-wrapper v1"
const NOTIFY_MARKER = "# Claxedo agent notification hook v1"
const SHELL_MARKER = "# Claxedo shell integration v1"
const OPENCODE_PLUGIN_MARKER = "// Claxedo opencode plugin v1"

// File names
const NOTIFY_SCRIPT = "notify.sh"
const CLAUDE_SETTINGS = "claude-settings.json"
const OPENCODE_PLUGIN = "claxedo-notify.js"
const CODEX_NOTIFY = "codex-notify.sh"
const CODEX_LOG_WATCHER = "codex-log-watcher.sh"
const GEMINI_HOOK = "gemini-hook.sh"
const CURSOR_HOOK = "cursor-hook.sh"
const COPILOT_HOOK = "copilot-hook.sh"
const COPILOT_PROJECT_HOOK = "claxedo-notify.json"
const OPENCODE_JSONC = "opencode.jsonc"
const DOC_AGENT_MD = "doc.md"
const WRAPPERS_JSON = "wrappers.json"

const DEFAULT_GENERIC_WRAPPERS = ["amp", "aider", "goose", "cline", "pi"]
const SHIMMED_BINARIES = new Set([
  "claude",
  "codex",
  "opencode",
  "gemini",
  "cursor",
  "cursor-agent",
  "copilot",
  "mastracode",
])

const WRAPPER_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/

const GEMINI_SETTINGS_PATH = path.join(os.homedir(), ".gemini", "settings.json")
const CURSOR_HOOKS_PATH = path.join(os.homedir(), ".cursor", "hooks.json")
const MASTRA_HOOKS_PATH = path.join(os.homedir(), ".mastracode", "hooks.json")

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

const normalizeWrappers = (items: string[]) => {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of items) {
    const next = value.trim().toLowerCase()
    if (!WRAPPER_NAME.test(next)) continue
    if (seen.has(next)) continue
    seen.add(next)
    result.push(next)
    if (result.length >= 48) break
  }
  return result
}

const wrappersPath = () => path.join(CLAXEDO_DIR, WRAPPERS_JSON)

const loadCustomWrappers = async () => {
  try {
    const raw = await fs.promises.readFile(wrappersPath(), "utf-8")
    const data = JSON.parse(raw) as { custom?: string[] }
    return normalizeWrappers(Array.isArray(data.custom) ? data.custom : [])
  } catch {
    return []
  }
}

const saveCustomWrappers = async (custom: string[]) => {
  const next = normalizeWrappers(custom)
  await fs.promises.mkdir(CLAXEDO_DIR, { recursive: true, mode: 0o755 })
  await writeIfChanged(wrappersPath(), JSON.stringify({ custom: next }, null, 2) + "\n", 0o644, true)
  return next
}

const asRecord = (value: unknown) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

const readJSON = async (filePath: string) => {
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8")
    return JSON.parse(raw) as unknown
  } catch {
    return {}
  }
}

const upsertGeminiHooks = async (hookPath: string, force: boolean) => {
  await fs.promises.mkdir(path.dirname(GEMINI_SETTINGS_PATH), { recursive: true, mode: 0o755 })
  const root = asRecord(await readJSON(GEMINI_SETTINGS_PATH))
  const hooks = asRecord(root.hooks)

  for (const event of ["BeforeAgent", "AfterAgent", "AfterTool"]) {
    const list = Array.isArray(hooks[event]) ? [...hooks[event]] : []
    const has = list.some((entry) => {
      const item = asRecord(entry)
      const nested = Array.isArray(item.hooks) ? item.hooks : []
      return nested.some((hook) => {
        const command = asRecord(hook)
        return command.type === "command" && command.command === hookPath
      })
    })
    if (!has) {
      list.push({ hooks: [{ type: "command", command: hookPath }] })
    }
    hooks[event] = list
  }

  root.hooks = hooks
  await writeIfChanged(GEMINI_SETTINGS_PATH, JSON.stringify(root, null, 2) + "\n", 0o644, force)
}

const upsertCursorHooks = async (hookPath: string, force: boolean) => {
  await fs.promises.mkdir(path.dirname(CURSOR_HOOKS_PATH), { recursive: true, mode: 0o755 })
  const root = asRecord(await readJSON(CURSOR_HOOKS_PATH))
  const hooks = asRecord(root.hooks)

  if (typeof root.version !== "number") {
    root.version = 1
  }

  const commandFor = (event: string) => `bash ${shellQuote(hookPath)} ${event}`
  const ensure = (event: string) => {
    const list = Array.isArray(hooks[event]) ? [...hooks[event]] : []
    const command = commandFor(event)
    if (!list.some((entry) => asRecord(entry).command === command)) {
      list.push({ command })
    }
    hooks[event] = list
  }

  ensure("beforeSubmitPrompt")
  ensure("stop")
  ensure("beforeShellExecution")
  ensure("beforeMCPExecution")

  root.hooks = hooks
  await writeIfChanged(CURSOR_HOOKS_PATH, JSON.stringify(root, null, 2) + "\n", 0o644, force)
}

const upsertMastraHooks = async (notifyPath: string, force: boolean) => {
  await fs.promises.mkdir(path.dirname(MASTRA_HOOKS_PATH), { recursive: true, mode: 0o755 })
  const root = asRecord(await readJSON(MASTRA_HOOKS_PATH))
  const command = `bash ${shellQuote(notifyPath)}`

  const ensure = (event: string) => {
    const list = Array.isArray(root[event]) ? [...root[event]] : []
    if (!list.some((entry) => asRecord(entry).command === command)) {
      list.push({ type: "command", command })
    }
    root[event] = list
  }

  ensure("UserPromptSubmit")
  ensure("Stop")
  ensure("PostToolUse")

  await writeIfChanged(MASTRA_HOOKS_PATH, JSON.stringify(root, null, 2) + "\n", 0o644, force)
}

/**
 * Find real binary function template (skips our wrapper directory)
 */
const FIND_REAL_BINARY = `
find_real_binary() {
  local name="$1"
  local IFS=':'
  for dir in $PATH; do
    [ -z "$dir" ] && continue
    case "$dir" in
      "${BIN_DIR}"|"$HOME/.claxedo/bin") continue ;;
    esac
    if [ -x "$dir/$name" ] && [ ! -d "$dir/$name" ]; then
      printf "%s\\n" "$dir/$name"
      return 0
    fi
  done
  return 1
}
`

/**
 * Generate the notify script
 */
function generateNotifyScript(port: number): string {
  const logFile = path.join(CLAXEDO_DIR, "debug.log")

  return `#!/bin/bash
${NOTIFY_MARKER}
# Called by CLI agents on lifecycle events

# Debug helper - writes to log file, not terminal
CLAXEDO_LOG="${logFile}"
debug() {
  [ "\${CLAXEDO_DEBUG:-0}" = "1" ] && echo "$(date '+%H:%M:%S') [notify] $*" >> "$CLAXEDO_LOG"
}

debug "notify.sh called with args: $*"
debug "CLAXEDO_TAB_ID=$CLAXEDO_TAB_ID CLAXEDO_PORT=$CLAXEDO_PORT"

[ -z "$CLAXEDO_TAB_ID" ] && { debug "No CLAXEDO_TAB_ID, exiting"; exit 0; }

	if [ -n "$1" ]; then
	  INPUT="$1"
	else
	  # Read from stdin when piped. Avoid blocking if invoked without stdin.
	  if [ -t 0 ]; then
	    INPUT="{}"
	  else
	    INPUT=$(cat 2>/dev/null)
	    [ -z "$INPUT" ] && INPUT="{}"
	  fi
	fi

	debug "Raw input: $INPUT"

extract_json_field() {
  local key="$1"
  echo "$INPUT" | grep -m1 -oE "\\"$key\\"[[:space:]]*:[[:space:]]*\\"[^\\"]*\\"" | grep -m1 -oE '"[^"]*"$' | tr -d '"' 2>/dev/null
}

extract_json_array_last() {
  local key="$1"
  echo "$INPUT" | grep -m1 -oE "\\"$key\\"[[:space:]]*:[[:space:]]*\[[^]]*\]" | grep -oE '"[^"]*"' | tail -n1 | tr -d '"' 2>/dev/null
}

EVENT_TYPE=""
CODEX_TYPE=""

EVENT_TYPE=$(echo "$INPUT" | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"' 2>/dev/null)
debug "hook_event_name extracted: $EVENT_TYPE"

if [ -z "$EVENT_TYPE" ]; then
  CODEX_TYPE=$(echo "$INPUT" | grep -oE '"type"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"' 2>/dev/null)
  debug "Codex type extracted: $CODEX_TYPE"
  case "$CODEX_TYPE" in
    "agent-turn-complete") EVENT_TYPE="Idle" ;;
    "agent-turn-start") EVENT_TYPE="Busy" ;;
    "permission-request"|"question-request") EVENT_TYPE="UserActionRequired" ;;
    "agent-turn-error"|"task-failed") EVENT_TYPE="Error" ;;
  esac
fi

case "$EVENT_TYPE" in
  "UserPromptSubmit"|"PostToolUse"|"BeforeAgent"|"AfterTool"|"beforeSubmitPrompt"|"sessionStart"|"userPromptSubmitted"|"postToolUse"|"Start") EVENT_TYPE="Busy" ;;
  "AfterAgent"|"stop"|"sessionEnd"|"Stop"|"Idle") EVENT_TYPE="Idle" ;;
  "PostToolUseFailure"|"session.error"|"sessionError"|"Error"|"Failed") EVENT_TYPE="Error" ;;
  "beforeShellExecution"|"beforeMCPExecution"|"PermissionRequest"|"QuestionRequest"|"question"|"question.asked") EVENT_TYPE="UserActionRequired" ;;
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

PROVIDER="\${CLAXEDO_AGENT:-}"
if [ -z "$PROVIDER" ]; then
  for key in provider provider_id providerId agent cli; do
    PROVIDER=$(extract_json_field "$key")
    [ -n "$PROVIDER" ] && break
  done
fi
if [ -z "$PROVIDER" ] && [ -n "$CODEX_TYPE" ]; then
  PROVIDER="codex"
fi

debug "Final EVENT_TYPE: $EVENT_TYPE"
debug "Session payload provider=$PROVIDER session=$SESSION_ID transcript=$TRANSCRIPT_PATH prompt=$PROMPT assistant=$LAST_ASSISTANT_MESSAGE"

[ -z "$EVENT_TYPE" ] && { debug "No event type, exiting"; exit 0; }

STATE_DIR="$HOME/.claxedo/state"
STATE_ID="\${CLAXEDO_TERMINAL_ID:-$CLAXEDO_TAB_ID}"
STATE_FILE="$STATE_DIR/$STATE_ID.agent"
mkdir -p "$STATE_DIR" 2>/dev/null || true

debug "State file: $STATE_FILE"

# Simple state tracking to prevent duplicate spurious settled events
if [ "$EVENT_TYPE" = "Busy" ] || [ "$EVENT_TYPE" = "UserActionRequired" ]; then
  echo "busy" > "$STATE_FILE" 2>/dev/null || true
  debug "State: marked busy"
fi

if [ "$EVENT_TYPE" = "Idle" ] || [ "$EVENT_TYPE" = "Error" ]; then
  if [ ! -f "$STATE_FILE" ]; then
    # First settled event for this terminal - allow it (handles Codex)
    echo "idle" > "$STATE_FILE" 2>/dev/null || true
    debug "State: first settled event, allowing"
  elif grep -q "^busy$" "$STATE_FILE" 2>/dev/null; then
    # Was busy, now idle
    echo "idle" > "$STATE_FILE" 2>/dev/null || true
    debug "State: marked idle"
  else
    # Already idle - duplicate settled event
    debug "Settled event ignored: already idle"
    exit 0
  fi
fi

HOOK_URL="http://127.0.0.1:\${CLAXEDO_PORT:-${port}}/hook/agent-lifecycle"
debug "Calling: $HOOK_URL tabId=$CLAXEDO_TAB_ID eventType=$EVENT_TYPE"

(
  RESPONSE=$(curl -sG "$HOOK_URL" \\
    --connect-timeout 1 \\
    --max-time 2 \\
    --data-urlencode "tabId=$CLAXEDO_TAB_ID" \\
    --data-urlencode "terminalId=$CLAXEDO_TERMINAL_ID" \\
    --data-urlencode "workspaceId=$CLAXEDO_WORKSPACE_ID" \\
    --data-urlencode "eventType=$EVENT_TYPE" \\
    --data-urlencode "provider=$PROVIDER" \\
    --data-urlencode "sessionId=$SESSION_ID" \\
    --data-urlencode "transcriptPath=$TRANSCRIPT_PATH" \\
    --data-urlencode "prompt=$PROMPT" \\
    --data-urlencode "lastAssistantMessage=$LAST_ASSISTANT_MESSAGE" \\
    2>&1)
  CURL_EXIT=$?
  [ "\${CLAXEDO_DEBUG:-0}" = "1" ] && echo "$(date '+%H:%M:%S') [notify] curl exit=$CURL_EXIT response=$RESPONSE" >> "$CLAXEDO_LOG"
) &

exit 0
`
}

/**
 * Generate Claude wrapper script
 */
function generateClaudeWrapper(): string {
  const settingsPath = path.join(HOOKS_DIR, CLAUDE_SETTINGS)
  const logFile = path.join(CLAXEDO_DIR, "debug.log")

  return `#!/bin/bash
${WRAPPER_MARKER}
set -uo pipefail

# Debug helper - writes to log file, not terminal
CLAXEDO_LOG="${logFile}"
debug() {
  [ "\${CLAXEDO_DEBUG:-0}" = "1" ] && echo "$(date '+%H:%M:%S') [claude] $*" >> "$CLAXEDO_LOG"
}

debug "wrapper called args: $*"

${FIND_REAL_BINARY}

REAL_CLAUDE="$(find_real_binary "claude")"
debug "Real binary: \${REAL_CLAUDE:-not found}"

if [ -z "$REAL_CLAUDE" ]; then
  echo "Claxedo: claude not found in PATH." >&2
  exit 127
fi

export CLAXEDO_AGENT="claude"

for arg in "$@"; do
  case "$arg" in
    --settings|--settings=*)
      debug "User provided --settings, bypassing"
      exec "$REAL_CLAUDE" "$@"
      ;;
  esac
done

debug "Injecting settings: ${settingsPath}"
exec "$REAL_CLAUDE" --settings "${settingsPath}" "$@"
`
}

/**
 * Generate Claude settings JSON with hooks
 */
function generateClaudeSettings(notifyPath: string): string {
  const settings = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: notifyPath }] }],
      PostToolUse: [{ hooks: [{ type: "command", command: notifyPath }] }],
      Stop: [{ hooks: [{ type: "command", command: notifyPath }] }],
      PostToolUseFailure: [{ hooks: [{ type: "command", command: notifyPath }] }],
      PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command: notifyPath }] }],
    },
  }
  return JSON.stringify(settings, null, 2)
}

/**
 * Generate Codex session log watcher
 */
function generateCodexLogWatcher(notifyPath: string): string {
  return `#!/bin/bash
${NOTIFY_MARKER}
set -uo pipefail

LOG_PATH="\${1:-}"
STATE_ID="\${2:-\${CLAXEDO_TERMINAL_ID:-$CLAXEDO_TAB_ID}}"

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
  echo '{"hook_event_name":"Busy"}' | "${notifyPath}" 2>/dev/null || true
fi

tail -n0 -F "$LOG_PATH" 2>/dev/null | while IFS= read -r line; do
  case "$line" in
    *'"type":"task_started"'*|*'"type": "task_started"'*)
      turn=$(echo "$line" | grep -oE '"turn_id"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"' 2>/dev/null)
      if [ -n "$turn" ] && [ -f "$TURN_FILE" ] && grep -q "^$turn$" "$TURN_FILE" 2>/dev/null; then
        continue
      fi
      [ -n "$turn" ] && echo "$turn" > "$TURN_FILE"
      echo '{"hook_event_name":"Busy"}' | "${notifyPath}" 2>/dev/null || true
      ;;
  esac
done

exit 0
`
}

/**
 * Generate Codex notify bridge
 */
function generateCodexNotify(notifyPath: string, watcherPath: string): string {
  return `#!/bin/bash
${NOTIFY_MARKER}
set -uo pipefail

if [ -n "$1" ]; then
  INPUT="$1"
else
  if [ -t 0 ]; then
    INPUT="{}"
  else
    INPUT=$(cat 2>/dev/null)
    [ -z "$INPUT" ] && INPUT="{}"
  fi
fi

# Fallback: start the log watcher from here if the wrapper's poller didn't.
if [ -n "\${CLAXEDO_TAB_ID:-}" ] && [ -n "\${CODEX_TUI_SESSION_LOG_PATH:-}" ]; then
  STATE_DIR="$HOME/.claxedo/state"
  STATE_ID="\${CLAXEDO_TERMINAL_ID:-$CLAXEDO_TAB_ID}"
  PID_FILE="$STATE_DIR/$STATE_ID.codex-watch.pid"
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null)
    if ! { [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; }; then
      rm -f "$PID_FILE"
    fi
  fi
  if [ ! -f "$PID_FILE" ]; then
    mkdir -p "$STATE_DIR" 2>/dev/null || true
    bash "${watcherPath}" "$CODEX_TUI_SESSION_LOG_PATH" "$STATE_ID" >/dev/null 2>&1 &
    echo $! > "$PID_FILE"
  fi
fi

exec "${notifyPath}" "$INPUT"
`
}

/**
 * Generate Codex wrapper script
 */
function generateCodexWrapper(codexNotifyPath: string, codexWatcherPath: string): string {
  const logFile = path.join(CLAXEDO_DIR, "debug.log")

  return `#!/bin/bash
${WRAPPER_MARKER}
set -uo pipefail

# Debug helper - writes to log file, not terminal
CLAXEDO_LOG="${logFile}"
debug() {
  [ "\${CLAXEDO_DEBUG:-0}" = "1" ] && echo "$(date '+%H:%M:%S') [codex] $*" >> "$CLAXEDO_LOG"
}

debug "wrapper called args: $*"

${FIND_REAL_BINARY}

REAL_CODEX="$(find_real_binary "codex")"
debug "Real binary: \${REAL_CODEX:-not found}"

if [ -z "$REAL_CODEX" ]; then
  echo "Claxedo: codex not found in PATH." >&2
  exit 127
fi

export CLAXEDO_AGENT="codex"

STATE_DIR="$HOME/.claxedo/state"
STATE_ID="\${CLAXEDO_TERMINAL_ID:-\${CLAXEDO_TAB_ID:-}}"
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

# Watch ~/.codex/sessions/ for a new session log file, then tail it for
# task_started events.  This is the only way to catch the first turn's Busy
# because Codex's notify hook only fires on agent-turn-complete (Idle).
if [ -n "$STATE_ID" ] && [ -n "\${CLAXEDO_TAB_ID:-}" ]; then
  (
    SESSION_DIR="$HOME/.codex/sessions/$(date +%Y/%m/%d)"
    mkdir -p "$SESSION_DIR" 2>/dev/null || true
    BEFORE=$(ls "$SESSION_DIR"/*.jsonl 2>/dev/null | wc -l)
    for _i in $(seq 1 60); do
      sleep 0.5
      NEWEST=$(ls -t "$SESSION_DIR"/*.jsonl 2>/dev/null | head -1)
      AFTER=$(ls "$SESSION_DIR"/*.jsonl 2>/dev/null | wc -l)
      if [ "$AFTER" -gt "$BEFORE" ] && [ -n "$NEWEST" ]; then
        debug "discovered session log: $NEWEST"
        exec bash "${codexWatcherPath}" "$NEWEST" "$STATE_ID"
      fi
    done
  ) >/dev/null 2>&1 &
  echo $! > "$PID_FILE"
fi

debug "Injecting notify: ${codexNotifyPath}"

"$REAL_CODEX" -c 'notify=["bash","${codexNotifyPath}"]' "$@"
EXIT_CODE=$?
exit $EXIT_CODE
`
}

/**
 * Generate passthrough wrapper for CLIs that rely on native hook files
 */
function generatePassthroughWrapper(binaryName: string): string {
  const logFile = path.join(CLAXEDO_DIR, "debug.log")

  return `#!/bin/bash
${WRAPPER_MARKER}
set -uo pipefail

# Debug helper - writes to log file, not terminal
CLAXEDO_LOG="${logFile}"
debug() {
  [ "\${CLAXEDO_DEBUG:-0}" = "1" ] && echo "$(date '+%H:%M:%S') [${binaryName}] $*" >> "$CLAXEDO_LOG"
}

debug "wrapper called args: $*"

${FIND_REAL_BINARY}

REAL_BIN="$(find_real_binary "${binaryName}")"
debug "Real binary: \${REAL_BIN:-not found}"

if [ -z "$REAL_BIN" ]; then
  echo "Claxedo: ${binaryName} not found in PATH." >&2
  exit 127
fi

export CLAXEDO_AGENT="${binaryName}"

exec "$REAL_BIN" "$@"
`
}

/**
 * Generate Gemini hook bridge (must return JSON)
 */
function generateGeminiHook(notifyPath: string): string {
  return `#!/bin/bash
${NOTIFY_MARKER}
set -uo pipefail

if [ -t 0 ]; then
  INPUT="{}"
else
  INPUT=$(cat 2>/dev/null)
  [ -z "$INPUT" ] && INPUT="{}"
fi

"${notifyPath}" "$INPUT" >/dev/null 2>&1 || true
printf '{}\\n'
exit 0
`
}

/**
 * Generate Cursor hook bridge (must return JSON)
 */
function generateCursorHook(notifyPath: string): string {
  return `#!/bin/bash
${NOTIFY_MARKER}
set -uo pipefail

EVENT="\${1:-}"
[ -t 0 ] || cat >/dev/null 2>&1 || true

if [ -n "$EVENT" ]; then
  printf '{"hook_event_name":"%s"}' "$EVENT" | "${notifyPath}" >/dev/null 2>&1 || true
fi

case "$EVENT" in
  "beforeShellExecution"|"beforeMCPExecution"|"PermissionRequest"|"UserActionRequired"|"QuestionRequest")
    printf '{"continue":true}\\n'
    ;;
  *)
    printf '{}\\n'
    ;;
esac

exit 0
`
}

/**
 * Generate Copilot hook bridge (must return JSON)
 */
function generateCopilotHook(notifyPath: string): string {
  return `#!/bin/bash
${NOTIFY_MARKER}
set -uo pipefail

EVENT="\${1:-}"
[ -t 0 ] || cat >/dev/null 2>&1 || true

if [ -n "$EVENT" ]; then
  printf '{"hook_event_name":"%s"}' "$EVENT" | "${notifyPath}" >/dev/null 2>&1 || true
fi

printf '{}\\n'
exit 0
`
}

function generateCopilotProjectHooks(copilotHookPath: string): string {
  const command = (event: string) => `bash ${shellQuote(copilotHookPath)} ${event}`
  const hooks = {
    version: 1,
    hooks: {
      sessionStart: [{ type: "command", bash: command("sessionStart"), timeoutSec: 5 }],
      sessionEnd: [{ type: "command", bash: command("sessionEnd"), timeoutSec: 5 }],
      userPromptSubmitted: [{ type: "command", bash: command("userPromptSubmitted"), timeoutSec: 5 }],
      postToolUse: [{ type: "command", bash: command("postToolUse"), timeoutSec: 5 }],
    },
  }
  return JSON.stringify(hooks, null, 2) + "\n"
}

/**
 * Generate Copilot wrapper script
 */
function generateCopilotWrapper(copilotHookPath: string): string {
  const logFile = path.join(CLAXEDO_DIR, "debug.log")
  const hookConfig = generateCopilotProjectHooks(copilotHookPath).trimEnd()

  return `#!/bin/bash
${WRAPPER_MARKER}
set -uo pipefail

# Debug helper - writes to log file, not terminal
CLAXEDO_LOG="${logFile}"
debug() {
  [ "\${CLAXEDO_DEBUG:-0}" = "1" ] && echo "$(date '+%H:%M:%S') [copilot] $*" >> "$CLAXEDO_LOG"
}

debug "wrapper called args: $*"

${FIND_REAL_BINARY}

REAL_COPILOT="$(find_real_binary "copilot")"
debug "Real binary: \${REAL_COPILOT:-not found}"

if [ -z "$REAL_COPILOT" ]; then
  echo "Claxedo: copilot not found in PATH." >&2
  exit 127
fi

export CLAXEDO_AGENT="copilot"

HOOK_REL=".github/hooks/${COPILOT_PROJECT_HOOK}"
HOOK_FILE="$PWD/$HOOK_REL"

mkdir -p "$PWD/.github/hooks" 2>/dev/null || true
# <<'EOF' disables shell expansion — hookConfig's shellQuote escaping
# (single-quote with '\\'' breakout) is written literally, which is correct
# since the JSON file content needs the literal single quotes.
cat > "$HOOK_FILE" <<'EOF'
${hookConfig}
EOF

if [ -d "$PWD/.git/info" ]; then
  EXCLUDE_FILE="$PWD/.git/info/exclude"
  touch "$EXCLUDE_FILE" 2>/dev/null || true
  if ! grep -qxF "$HOOK_REL" "$EXCLUDE_FILE" 2>/dev/null; then
    printf "\\n$HOOK_REL\\n" >> "$EXCLUDE_FILE"
  fi
fi

exec "$REAL_COPILOT" "$@"
`
}

/**
 * Generate generic wrapper for agents without native hook support
 */
function generateGenericWrapper(binaryName: string, notifyPath: string): string {
  const logFile = path.join(CLAXEDO_DIR, "debug.log")

  return `#!/bin/bash
${WRAPPER_MARKER}
set -uo pipefail

# Debug helper - writes to log file, not terminal
CLAXEDO_LOG="${logFile}"
debug() {
  [ "\${CLAXEDO_DEBUG:-0}" = "1" ] && echo "$(date '+%H:%M:%S') [${binaryName}] $*" >> "$CLAXEDO_LOG"
}

debug "wrapper called args: $*"

${FIND_REAL_BINARY}

REAL_BIN="$(find_real_binary "${binaryName}")"
debug "Real binary: \${REAL_BIN:-not found}"

if [ -z "$REAL_BIN" ]; then
  echo "Claxedo: ${binaryName} not found in PATH." >&2
  exit 127
fi

export CLAXEDO_AGENT="${binaryName}"

if [ -n "\${CLAXEDO_TAB_ID:-}" ]; then
  debug "Sending Busy event"
  echo '{"hook_event_name":"Busy"}' | "${notifyPath}" 2>/dev/null &
fi

debug "Executing: $REAL_BIN $*"
"$REAL_BIN" "$@"
EXIT_CODE=$?

if [ -n "\${CLAXEDO_TAB_ID:-}" ]; then
  debug "Sending Idle event (exit=$EXIT_CODE)"
  echo '{"hook_event_name":"Idle"}' | "${notifyPath}" 2>/dev/null &
fi

exit $EXIT_CODE
`
}

/**
 * Generate OpenCode wrapper script
 * Sets OPENCODE_CONFIG_DIR to our config directory containing the plugin
 */
function generateOpenCodeWrapper(): string {
  const logFile = path.join(CLAXEDO_DIR, "debug.log")

  return `#!/bin/bash
${WRAPPER_MARKER}
set -uo pipefail

# Debug helper - writes to log file, not terminal
CLAXEDO_LOG="${logFile}"
debug() {
  [ "\${CLAXEDO_DEBUG:-0}" = "1" ] && echo "$(date '+%H:%M:%S') [opencode] $*" >> "$CLAXEDO_LOG"
}

debug "wrapper called args: $*"

${FIND_REAL_BINARY}

REAL_OPENCODE="$(find_real_binary "opencode")"
debug "Real binary: \${REAL_OPENCODE:-not found}"

if [ -z "$REAL_OPENCODE" ]; then
  echo "Claxedo: opencode not found in PATH." >&2
  exit 127
fi

export CLAXEDO_AGENT="opencode"

debug "Injecting OPENCODE_CONFIG_DIR: ${OPENCODE_CONFIG_DIR}"
export OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR}"
exec "$REAL_OPENCODE" "$@"
`
}

/**
 * Generate OpenCode notification plugin
 * This hooks into OpenCode's internal events (session.status, permission.ask)
 */
function generateOpenCodePlugin(notifyPath: string): string {
  // Use template literal with escaped backticks for the shell command
  const shellCommand = "`bash ${notifyPath} ${payload}`"

  return `${OPENCODE_PLUGIN_MARKER}
/**
 * Claxedo Notification Plugin for OpenCode
 *
 * Hooks into session.status and permission.ask events to send notifications.
 */
export const ClaxedoNotifyPlugin = async ({ $ }) => {
  if (globalThis.__claxedoOpencodePluginV1) return {};
  globalThis.__claxedoOpencodePluginV1 = true;

  // Only run inside a Claxedo terminal session
  if (!process?.env?.CLAXEDO_TAB_ID) return {};

  const notifyPath = "${notifyPath}";

  // State tracking for deduplication
  let currentState = 'idle'; // 'idle' | 'busy'

  const sessionMeta = (event) => {
    const sessionID = event?.properties?.sessionID || event?.properties?.sessionId || event?.properties?.session_id;
    if (typeof sessionID !== "string" || !sessionID) return {};
    return { session_id: sessionID };
  };

  const notify = async (hookEventName, extra = {}) => {
    const payload = JSON.stringify({ hook_event_name: hookEventName, ...extra });
    try {
      await $${shellCommand};
    } catch (err) {
      // Notification failed, silently ignore
    }
  };

  return {
    event: async ({ event }) => {
      // Skip child sessions (subagents)
      if (event.properties?.parentID) return;

      // Handle session status changes
      if (event.type === "session.status") {
        const status = event.properties?.status;
        if (status?.type === "busy" && currentState === 'idle') {
          currentState = 'busy';
          await notify('Busy', sessionMeta(event));
        } else if (status?.type === "idle" && currentState === 'busy') {
          currentState = 'idle';
          await notify('Idle', sessionMeta(event));
        }
      }

      // Handle deprecated event types for backwards compatibility
      if (event.type === "session.busy" && currentState === 'idle') {
        currentState = 'busy';
        await notify('Busy', sessionMeta(event));
      }
      if (event.type === "session.idle" && currentState === 'busy') {
        currentState = 'idle';
        await notify('Idle', sessionMeta(event));
      }

      // Handle session errors
      if (event.type === "session.error") {
        currentState = 'idle';
        await notify('Error', sessionMeta(event));
      }

      if (event.type === "question.asked") {
        await notify("UserActionRequired", sessionMeta(event));
      }
    },
    "permission.ask": async (permission, output) => {
      if (output.status === "ask") {
        const extra =
          typeof permission?.sessionID === "string" && permission.sessionID
            ? { session_id: permission.sessionID }
            : {};
        await notify("UserActionRequired", extra);
      }
    },
  };
};
`
}

/**
 * Generate zsh config for ZDOTDIR
 */
function generateZshrc(): string {
  const logFile = path.join(CLAXEDO_DIR, "debug.log")

  return `${SHELL_MARKER}
_CLAXEDO_ORIG_ZDOTDIR="\${CLAXEDO_ORIG_ZDOTDIR:-$HOME}"

# Safety: never source from our own directory (prevents recursion)
_claxedo_shell_norm="${SHELL_DIR}"
_claxedo_orig_norm="\${_CLAXEDO_ORIG_ZDOTDIR:A}"
_claxedo_shell_norm="\${_claxedo_shell_norm:A}"
[ "\${_claxedo_orig_norm%/}" = "\${_claxedo_shell_norm%/}" ] && _CLAXEDO_ORIG_ZDOTDIR="$HOME"

# Debug helper - writes to log file, not terminal
_claxedo_debug() {
  [ "\${CLAXEDO_DEBUG:-0}" = "1" ] && echo "$(date '+%H:%M:%S') [zsh] $*" >> "${logFile}"
}

_claxedo_debug "Loading .zshrc TAB_ID=\${CLAXEDO_TAB_ID:-unset}"

if [ -f "$_CLAXEDO_ORIG_ZDOTDIR/.zshenv" ]; then
  _claxedo_debug "Sourcing $_CLAXEDO_ORIG_ZDOTDIR/.zshenv"
  source "$_CLAXEDO_ORIG_ZDOTDIR/.zshenv"
fi

if [ -f "$_CLAXEDO_ORIG_ZDOTDIR/.zshrc" ]; then
  _claxedo_debug "Sourcing $_CLAXEDO_ORIG_ZDOTDIR/.zshrc"
  source "$_CLAXEDO_ORIG_ZDOTDIR/.zshrc"
fi

export PATH="${BIN_DIR}:\$PATH"
_claxedo_debug "PATH updated"
`
}

/**
 * Generate zshenv
 */
function generateZshenv(): string {
  return `${SHELL_MARKER}
if [ -z "\${CLAXEDO_ORIG_ZDOTDIR:-}" ]; then
  _claxedo_shell_norm="${SHELL_DIR}"
  _claxedo_zdotdir="\${ZDOTDIR:-$HOME}"
  _claxedo_shell_norm="\${_claxedo_shell_norm:A}"
  _claxedo_zdotdir="\${_claxedo_zdotdir:A}"
  # Guard: if ZDOTDIR already points to our shell dir, fall back to HOME
  if [ "\${_claxedo_zdotdir%/}" = "\${_claxedo_shell_norm%/}" ]; then
    export CLAXEDO_ORIG_ZDOTDIR="$HOME"
  else
    export CLAXEDO_ORIG_ZDOTDIR="\${ZDOTDIR:-$HOME}"
  fi
fi
`
}

/**
 * Generate bash config for BASH_ENV
 */
function generateBashrc(): string {
  const logFile = path.join(CLAXEDO_DIR, "debug.log")

  return `${SHELL_MARKER}
# Debug helper - writes to log file, not terminal
_claxedo_debug() {
  [ "\${CLAXEDO_DEBUG:-0}" = "1" ] && echo "$(date '+%H:%M:%S') [bash] $*" >> "${logFile}"
}

_claxedo_debug "Loading .bashrc TAB_ID=\${CLAXEDO_TAB_ID:-unset}"

if [ -f "$HOME/.bashrc" ]; then
  _claxedo_debug "Sourcing $HOME/.bashrc"
  source "$HOME/.bashrc"
fi

export PATH="${BIN_DIR}:\$PATH"
_claxedo_debug "PATH updated"
`
}

/**
 * Resolve the claxedo-mcp command.
 *
 * Checks two locations in order:
 * 1. Sibling of process.execPath — works in Tauri sidecar mode (claxedo-mcp compiled alongside opencode-cli)
 * 2. Source file via import.meta.url — works in dev mode (bun runs the .ts directly)
 */
function resolveClaxedoMcpCommand(): string[] {
  // 1. Compiled binary adjacent to the running process (Tauri sidecar mode)
  const execDir = path.dirname(process.execPath)
  try {
    const entries = fs.readdirSync(execDir)
    for (const entry of entries) {
      if (entry === "claxedo-mcp" || entry.startsWith("claxedo-mcp-")) {
        const candidate = path.join(execDir, entry)
        try {
          fs.accessSync(candidate, fs.constants.X_OK)
          log.info("Resolved claxedo-mcp from sidecar directory", { path: candidate })
          return [candidate]
        } catch {}
      }
    }
  } catch {}

  // 2. Source file via import.meta.url (development mode)
  try {
    const sourcePath = new URL("../mcp/claxedo-mcp.ts", import.meta.url).pathname
    if (fs.existsSync(sourcePath)) {
      return ["bun", sourcePath]
    }
  } catch {}

  log.warn("Could not resolve claxedo-mcp binary or source file")
  return []
}

/**
 * Generate the doc agent markdown config (merged council + page assistant)
 */
function generateDocAgentMd(): string {
  return `---
mode: all
hidden: true
description: "Page & council assistant — helps with the current document and can run multi-agent analysis."
color: "#6B7280"
---
You are a document assistant for a rich-text page editor.
The system prompt tells you the page's markdown mirror path — read it to understand the current content.

When running in a terminal with Claxedo agent hooks, you can resolve current tab and pane context with the MCP tool \`tab_context\`.
Call it without arguments to use \`CLAXEDO_TAB_ID\` / \`CLAXEDO_TERMINAL_ID\`, or pass \`pane_name\` to extract a named pane (for example, \`#doc\`).

**Page tasks**: answer questions, suggest edits, summarise, and help the user with their document. Keep answers concise and relevant to the page.

**Council tasks**: when the user asks for a debate, review, or multi-perspective analysis, use the \`council\` MCP tool. Pass the current page id and session id so council members can read the page content. Summarise the council result for the user.
`
}

/**
 * Generate the opencode.jsonc MCP config
 */
function generateOpencodeJsonc(port: number): string {
  const command = resolveClaxedoMcpCommand()
  if (!command.length) {
    log.warn("Skipping claxedo-mcp in opencode.jsonc — binary not found")
    return JSON.stringify({}, null, 2) + "\n"
  }
  const config = {
    mcp: {
      "claxedo-mcp": {
        type: "local",
        command,
        environment: {
          OPENCODE_API_URL: `http://localhost:${port}`,
        },
      },
    },
  }
  return JSON.stringify(config, null, 2) + "\n"
}

/**
 * Write file if content changed
 */
async function writeIfChanged(filePath: string, content: string, mode: number, force: boolean): Promise<boolean> {
  const tempPath = `${filePath}.tmp.${Date.now()}-${Math.random().toString(36).slice(2)}`
  try {
    if (!force && fs.existsSync(filePath)) {
      try {
        const existing = await fs.promises.readFile(filePath, "utf-8")
        if (existing === content) return false
      } catch {}
    }

    // Atomic write via temp file to prevent partial writes or race conditions
    await fs.promises.writeFile(tempPath, content, { mode })

    try {
      await fs.promises.rename(tempPath, filePath)
    } catch (renameError) {
      // Handle cross-device link errors by copying and deleting
      await fs.promises.copyFile(tempPath, filePath)
      await fs.promises.unlink(tempPath)
      await fs.promises.chmod(filePath, mode)
    }

    return true
  } catch (error) {
    log.error("Failed to write file", { filePath, error })
    // Attempt cleanup of temp file
    try {
      if (fs.existsSync(tempPath)) {
        await fs.promises.unlink(tempPath)
      }
    } catch {}
    throw error
  }
}

export interface SetupOptions {
  port?: number
  force?: boolean
  wrappers?: string[]
  replaceWrappers?: boolean
}

/**
 * Set up agent hooks infrastructure
 */
export async function setupAgentHooks(options: SetupOptions = {}): Promise<void> {
  const { port = 7860, force = false, wrappers, replaceWrappers = false } = options

  log.info("Setting up agent hooks", { port, force, DEBUG })

  if (DEBUG) {
    log.info("Agent hooks directories", {
      CLAXEDO_DIR,
      BIN_DIR,
      HOOKS_DIR,
      SHELL_DIR,
    })
  }

  // Create directories
  await fs.promises.mkdir(BIN_DIR, { recursive: true, mode: 0o755 })
  await fs.promises.mkdir(HOOKS_DIR, { recursive: true, mode: 0o755 })
  await fs.promises.mkdir(SHELL_DIR, { recursive: true, mode: 0o755 })
  await fs.promises.mkdir(OPENCODE_PLUGIN_DIR, { recursive: true, mode: 0o755 })
  await fs.promises.mkdir(OPENCODE_AGENT_DIR, { recursive: true, mode: 0o755 })

  const notifyPath = path.join(HOOKS_DIR, NOTIFY_SCRIPT)
  const codexNotifyPath = path.join(HOOKS_DIR, CODEX_NOTIFY)
  const codexWatcherPath = path.join(HOOKS_DIR, CODEX_LOG_WATCHER)
  const geminiHookPath = path.join(HOOKS_DIR, GEMINI_HOOK)
  const cursorHookPath = path.join(HOOKS_DIR, CURSOR_HOOK)
  const copilotHookPath = path.join(HOOKS_DIR, COPILOT_HOOK)

  // Create notify script
  await writeIfChanged(notifyPath, generateNotifyScript(port), 0o755, force)
  await writeIfChanged(codexWatcherPath, generateCodexLogWatcher(notifyPath), 0o755, force)
  await writeIfChanged(codexNotifyPath, generateCodexNotify(notifyPath, codexWatcherPath), 0o755, force)
  await writeIfChanged(geminiHookPath, generateGeminiHook(notifyPath), 0o755, force)
  await writeIfChanged(cursorHookPath, generateCursorHook(notifyPath), 0o755, force)
  await writeIfChanged(copilotHookPath, generateCopilotHook(notifyPath), 0o755, force)

  // Create Claude wrapper and settings
  await writeIfChanged(path.join(BIN_DIR, "claude"), generateClaudeWrapper(), 0o755, force)
  await writeIfChanged(path.join(HOOKS_DIR, CLAUDE_SETTINGS), generateClaudeSettings(notifyPath), 0o644, force)

  // Create Codex wrapper
  await writeIfChanged(
    path.join(BIN_DIR, "codex"),
    generateCodexWrapper(codexNotifyPath, codexWatcherPath),
    0o755,
    force,
  )

  // Create OpenCode wrapper and plugin
  await writeIfChanged(path.join(BIN_DIR, "opencode"), generateOpenCodeWrapper(), 0o755, force)
  await writeIfChanged(
    path.join(OPENCODE_PLUGIN_DIR, OPENCODE_PLUGIN),
    generateOpenCodePlugin(notifyPath),
    0o644,
    force,
  )

  // Create wrappers for CLIs with native hook files
  await writeIfChanged(path.join(BIN_DIR, "gemini"), generatePassthroughWrapper("gemini"), 0o755, force)
  await writeIfChanged(path.join(BIN_DIR, "cursor"), generatePassthroughWrapper("cursor"), 0o755, force)
  await writeIfChanged(path.join(BIN_DIR, "cursor-agent"), generatePassthroughWrapper("cursor-agent"), 0o755, force)
  await writeIfChanged(path.join(BIN_DIR, "copilot"), generateCopilotWrapper(copilotHookPath), 0o755, force)
  await writeIfChanged(path.join(BIN_DIR, "mastracode"), generatePassthroughWrapper("mastracode"), 0o755, force)

  // Install native hook config entries (merge to preserve user hooks)
  await upsertGeminiHooks(geminiHookPath, force).catch((error) => {
    log.warn("Failed to configure Gemini hooks", { error })
  })
  await upsertCursorHooks(cursorHookPath, force).catch((error) => {
    log.warn("Failed to configure Cursor hooks", { error })
  })
  await upsertMastraHooks(notifyPath, force).catch((error) => {
    log.warn("Failed to configure Mastra hooks", { error })
  })

  const existingCustom = await loadCustomWrappers()
  const incoming = normalizeWrappers(wrappers ?? [])
  const custom =
    wrappers === undefined
      ? existingCustom
      : replaceWrappers
        ? await saveCustomWrappers(incoming)
        : await saveCustomWrappers([...existingCustom, ...incoming])

  // Create generic wrappers
  for (const agent of normalizeWrappers([...DEFAULT_GENERIC_WRAPPERS, ...custom]).filter(
    (agent) => !SHIMMED_BINARIES.has(agent),
  )) {
    await writeIfChanged(path.join(BIN_DIR, agent), generateGenericWrapper(agent, notifyPath), 0o755, force)
  }

  // Create doc agent config and MCP config
  await writeIfChanged(path.join(OPENCODE_AGENT_DIR, DOC_AGENT_MD), generateDocAgentMd(), 0o644, force)
  await writeIfChanged(path.join(OPENCODE_CONFIG_DIR, OPENCODE_JSONC), generateOpencodeJsonc(port), 0o644, force)

  // Create shell integration
  await writeIfChanged(path.join(SHELL_DIR, ".zshrc"), generateZshrc(), 0o644, force)
  await writeIfChanged(path.join(SHELL_DIR, ".zshenv"), generateZshenv(), 0o644, force)
  await writeIfChanged(path.join(SHELL_DIR, ".bashrc"), generateBashrc(), 0o644, force)

  log.info("Agent hooks setup complete", { binDir: BIN_DIR })
}

export async function listWrapperAgents() {
  const custom = await loadCustomWrappers()
  const defaults = normalizeWrappers(DEFAULT_GENERIC_WRAPPERS)
  const all = normalizeWrappers([...defaults, ...custom, ...SHIMMED_BINARIES])
  return {
    defaults,
    custom,
    all,
  }
}

/**
 * Check if setup is complete
 */
export function isSetupComplete(): boolean {
  const requiredFiles = [
    path.join(HOOKS_DIR, NOTIFY_SCRIPT),
    path.join(HOOKS_DIR, CODEX_NOTIFY),
    path.join(HOOKS_DIR, CODEX_LOG_WATCHER),
    path.join(HOOKS_DIR, GEMINI_HOOK),
    path.join(HOOKS_DIR, CURSOR_HOOK),
    path.join(HOOKS_DIR, COPILOT_HOOK),
    path.join(BIN_DIR, "claude"),
    path.join(BIN_DIR, "codex"),
    path.join(BIN_DIR, "opencode"),
    path.join(BIN_DIR, "gemini"),
    path.join(BIN_DIR, "cursor"),
    path.join(BIN_DIR, "cursor-agent"),
    path.join(BIN_DIR, "copilot"),
    path.join(BIN_DIR, "mastracode"),
    path.join(OPENCODE_PLUGIN_DIR, OPENCODE_PLUGIN),
    path.join(SHELL_DIR, ".zshrc"),
    path.join(OPENCODE_AGENT_DIR, DOC_AGENT_MD),
    path.join(OPENCODE_CONFIG_DIR, OPENCODE_JSONC),
  ]
  return requiredFiles.every((file) => fs.existsSync(file))
}

// Check if debug mode is enabled
const DEBUG = process.env.CLAXEDO_DEBUG === "1"

/**
 * Get environment variables for terminal PTY
 */
export function getTerminalEnvVars(params: {
  tabId: string
  terminalId: string
  workspaceId: string
  port: number
  shell?: string
}): Record<string, string> {
  const { tabId, terminalId, workspaceId, port, shell } = params

  if (DEBUG) {
    log.info("getTerminalEnvVars called", params)
  }

  const env: Record<string, string> = {
    CLAXEDO_TAB_ID: tabId,
    CLAXEDO_TERMINAL_ID: terminalId,
    CLAXEDO_WORKSPACE_ID: workspaceId,
    CLAXEDO_PORT: String(port),
    CLAXEDO_MCP_TOOL: "tab_context",
    CLAXEDO_MCP_HINT:
      "Use claxedo-mcp tab_context to fetch current tab and named pane context. Defaults resolve from CLAXEDO_TAB_ID/CLAXEDO_TERMINAL_ID.",
    CLAXEDO_TAB_PROMPT: `Current tab is ${tabId}. Call the MCP tool tab_context to load full tab state, or tab_context pane_name=#doc for named pane context.`,
  }

  // Pass through debug flag to shell scripts
  if (DEBUG) {
    env.CLAXEDO_DEBUG = "1"
  }

  // Shell integration
  const shellName = shell?.split("/").pop() || ""
  if (shellName === "zsh" || shellName.includes("zsh")) {
    env.ZDOTDIR = SHELL_DIR
    env.CLAXEDO_ORIG_ZDOTDIR = process.env.ZDOTDIR || process.env.HOME || ""
    if (DEBUG) {
      log.info("Shell integration: zsh", { ZDOTDIR: env.ZDOTDIR })
    }
  } else if (shellName === "bash" || shellName.includes("bash")) {
    env.BASH_ENV = path.join(SHELL_DIR, ".bashrc")
    if (DEBUG) {
      log.info("Shell integration: bash", { BASH_ENV: env.BASH_ENV })
    }
  } else {
    // Fallback: directly modify PATH
    env.PATH = `${BIN_DIR}:${process.env.PATH || ""}`
    if (DEBUG) {
      log.info("Shell integration: fallback PATH modification", { shell: shellName })
    }
  }

  if (DEBUG) {
    log.info("Terminal env vars prepared", { tabId, terminalId, envKeys: Object.keys(env) })
  }

  return env
}

/**
 * Clean up agent hooks
 */
export async function cleanupAgentHooks(): Promise<void> {
  log.info("Cleaning up agent hooks")
  await fs.promises.rm(CLAXEDO_DIR, { recursive: true, force: true })
  log.info("Agent hooks cleanup complete")
}

// Export constants
export { CLAXEDO_DIR, BIN_DIR, HOOKS_DIR, SHELL_DIR, OPENCODE_CONFIG_DIR, OPENCODE_PLUGIN_DIR, OPENCODE_AGENT_DIR }
