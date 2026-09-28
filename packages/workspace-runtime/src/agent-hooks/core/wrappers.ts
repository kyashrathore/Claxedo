/**
 * Agent Wrappers
 *
 * Binary wrapper generation and custom wrapper management.
 * Uses buildWrapperScript() composition to avoid boilerplate duplication.
 */

import * as fs from "fs"
import * as path from "path"
import {
  CLAXEDO_DIR,
  COPILOT_PROJECT_HOOK,
  FIND_REAL_BINARY,
  WRAPPER_MARKER,
  WRAPPER_NAME,
  WRAPPERS_JSON,
  DEFAULT_GENERIC_WRAPPERS,
  SHIMMED_BINARIES,
} from "./constants"
import { loadTemplate, shellQuote, writeIfChanged } from "./utils"
import { arr, rec } from "../../json-value"
import { generateCopilotProjectHooks } from "./hooks"

// ── Wrapper composition ────────────────────────────────────────────────────

/**
 * Build a complete wrapper script with common boilerplate.
 * Composes: shebang + marker + find_real_binary + missing-binary check + exec block.
 */
export function buildWrapperScript(binaryName: string, execBlock: string): string {
  return loadTemplate("wrapper-common.template.sh", {
    MARKER: WRAPPER_MARKER,
    FIND_REAL_BINARY,
    BINARY_NAME: binaryName,
    EXEC_BLOCK: execBlock,
  })
}

// ── Wrapper generators ──────────────────────────────────────────────────────

export function generateClaudeWrapper(notifyPath: string, settingsPath: string): string {
  return buildWrapperScript("claude", `# Ensure status is cleared even if Claude crashes, hits a limit, or is killed
cleanup() {
  EXIT_CODE=$?
  if [ "$EXIT_CODE" -eq 0 ]; then
    echo '{"hook_event_name":"Idle"}' | bash ${shellQuote(notifyPath)} >/dev/null 2>&1 &
  else
    echo '{"hook_event_name":"Error"}' | bash ${shellQuote(notifyPath)} >/dev/null 2>&1 &
  fi
}
trap cleanup EXIT

# Do not use exec here — exec replaces the shell process, which
# prevents the EXIT trap from firing.
"$REAL_BIN" --settings ${shellQuote(settingsPath)} "$@"`)
}

const CODEX_LIFECYCLE_HOOKS: readonly { event: string; matcher?: string }[] = [
  { event: "SessionStart" },
  { event: "SessionEnd" },
  { event: "UserPromptSubmit" },
  { event: "PreToolUse", matcher: "^request_user_input$" },
  { event: "PostToolUse", matcher: "*" },
  { event: "PermissionRequest" },
  { event: "Stop" },
  { event: "Interrupt" },
  { event: "SubagentStart" },
  { event: "SubagentStop" },
]

export function codexHookFlags(notifyPath: string): string[] {
  const command = JSON.stringify(`${shellQuote(notifyPath)} --harness=codex`)
  return CODEX_LIFECYCLE_HOOKS.flatMap(({ event, matcher }) => [
    "-c",
    `hooks.${event}=[{${matcher ? `matcher=${JSON.stringify(matcher)},` : ""}hooks=[{type="command",command=${command}}]}]`,
  ])
}

export function generateCodexWrapper(notifyPath: string): string {
  return buildWrapperScript("codex", loadTemplate("codex-wrapper-exec.template.sh", {
    HOOK_FLAGS: codexHookFlags(notifyPath).map(shellQuote).join(" "),
  }))
}

export function generatePassthroughWrapper(binaryName: string): string {
  return buildWrapperScript(binaryName, `exec "$REAL_BIN" "$@"`)
}

export function generateGenericWrapper(binaryName: string, notifyPath: string): string {
  return buildWrapperScript(binaryName, `if [ -n "\${CLAXEDO_TAB_ID:-}" ]; then
  echo '{"hook_event_name":"Busy"}' | ${shellQuote(notifyPath)} 2>/dev/null &
fi

"$REAL_BIN" "$@"
EXIT_CODE=$?

if [ -n "\${CLAXEDO_TAB_ID:-}" ]; then
  if [ $EXIT_CODE -ne 0 ]; then
    echo '{"hook_event_name":"Error"}' | ${shellQuote(notifyPath)} 2>/dev/null &
  else
    echo '{"hook_event_name":"Idle"}' | ${shellQuote(notifyPath)} 2>/dev/null &
  fi
fi

exit $EXIT_CODE`)
}

export function generateCopilotWrapper(copilotHookPath: string): string {
  const hooksJson = generateCopilotProjectHooks(copilotHookPath)
  const escapedJson = hooksJson.replace(/'/g, "'\\''")

  return buildWrapperScript("copilot", `# Copilot CLI only supports project-level hooks (.github/hooks/*.json in CWD).
# Auto-inject Claxedo notification hooks when running inside a Claxedo terminal.
if [ -n "$CLAXEDO_TAB_ID" ] && [ -f ${shellQuote(copilotHookPath)} ]; then
  COPILOT_HOOKS_DIR=".github/hooks"
  COPILOT_HOOK_FILE="$COPILOT_HOOKS_DIR/${COPILOT_PROJECT_HOOK}"
  COPILOT_HOOKS='${escapedJson}'

  if [ "$(cat "$COPILOT_HOOK_FILE" 2>/dev/null)" != "$(printf '%s\\n' "$COPILOT_HOOKS")" ]; then
    mkdir -p "$COPILOT_HOOKS_DIR" 2>/dev/null &&
      printf '%s\\n' "$COPILOT_HOOKS" > "$COPILOT_HOOK_FILE.tmp.$$" 2>/dev/null &&
      mv -f "$COPILOT_HOOK_FILE.tmp.$$" "$COPILOT_HOOK_FILE" 2>/dev/null
  fi

  COPILOT_EXCLUDE=".git/info/exclude"
  if [ -d ".git/info" ] && ! grep -qxF ".github/hooks/${COPILOT_PROJECT_HOOK}" "$COPILOT_EXCLUDE" 2>/dev/null; then
    # Never join the line onto a last entry the person left without a newline.
    [ -s "$COPILOT_EXCLUDE" ] && [ -n "$(tail -c 1 "$COPILOT_EXCLUDE")" ] && printf '\\n' >> "$COPILOT_EXCLUDE"
    printf '%s\\n' ".github/hooks/${COPILOT_PROJECT_HOOK}" >> "$COPILOT_EXCLUDE" 2>/dev/null
  fi
fi

exec "$REAL_BIN" "$@"`)
}

// ── Custom wrapper management ───────────────────────────────────────────────

export const normalizeWrappers = (items: string[]) => {
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

const wrappersPath = (root = CLAXEDO_DIR) => path.join(root, WRAPPERS_JSON)

export const loadCustomWrappers = async (root = CLAXEDO_DIR) => {
  try {
    const raw = await fs.promises.readFile(wrappersPath(root), "utf-8")
    const custom = arr(rec(JSON.parse(raw))?.custom) ?? []
    return normalizeWrappers(custom.filter((item): item is string => typeof item === "string"))
  } catch {
    return []
  }
}

export const saveCustomWrappers = async (custom: string[], root = CLAXEDO_DIR) => {
  const next = normalizeWrappers(custom)
  await fs.promises.mkdir(root, { recursive: true, mode: 0o755 })
  await writeIfChanged(wrappersPath(root), JSON.stringify({ custom: next }, null, 2) + "\n", 0o644, true)
  return next
}

export async function listWrapperAgents(root = CLAXEDO_DIR) {
  const custom = await loadCustomWrappers(root)
  const defaults = normalizeWrappers(DEFAULT_GENERIC_WRAPPERS)
  const all = normalizeWrappers([...defaults, ...custom, ...SHIMMED_BINARIES])
  return { defaults, custom, all }
}
