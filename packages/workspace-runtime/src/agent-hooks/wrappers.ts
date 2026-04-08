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
  OPENCODE_CONFIG_DIR,
  WRAPPER_MARKER,
  WRAPPER_NAME,
  WRAPPERS_JSON,
  DEFAULT_GENERIC_WRAPPERS,
  SHIMMED_BINARIES,
} from "./constants"
import { loadTemplate, shellQuote, writeIfChanged } from "./utils"
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

export function generateClaudeWrapper(notifyPath: string): string {
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

exec "$REAL_BIN" "$@"`)
}

export function generateCodexWrapper(opts: { notifyPath: string; watcherPath: string; native: boolean }): string {
  const template = opts.native ? "codex-wrapper-exec.template.sh" : "codex-wrapper-exec-legacy.template.sh"
  return buildWrapperScript("codex", loadTemplate(template, {
    CODEX_NOTIFY_PATH: opts.notifyPath,
    CODEX_WATCHER_PATH: opts.watcherPath,
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

export function generateOpenCodeWrapper(): string {
  return buildWrapperScript("opencode",
    `export OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR}"\nexec "$REAL_BIN" "$@"`)
}

export function generateCopilotWrapper(copilotHookPath: string): string {
  const hooksJson = generateCopilotProjectHooks(copilotHookPath)
  const escapedJson = hooksJson.replace(/'/g, "'\\''")

  return buildWrapperScript("copilot", `# Copilot CLI only supports project-level hooks (.github/hooks/*.json in CWD).
# Auto-inject Claxedo notification hooks when running inside a Claxedo terminal.
if [ -n "$CLAXEDO_TAB_ID" ] && [ -f ${shellQuote(copilotHookPath)} ]; then
  COPILOT_HOOKS_DIR=".github/hooks"
  COPILOT_HOOK_FILE="$COPILOT_HOOKS_DIR/${COPILOT_PROJECT_HOOK}"

  # Always refresh our dedicated hook file so stale paths cannot break notifications.
  mkdir -p "$COPILOT_HOOKS_DIR" 2>/dev/null
  printf '%s\\n' '${escapedJson}' > "$COPILOT_HOOK_FILE" 2>/dev/null

  if [ -d ".git/info" ]; then
    grep -qF ".github/hooks/${COPILOT_PROJECT_HOOK}" ".git/info/exclude" 2>/dev/null || \\
      printf '%s\\n' ".github/hooks/${COPILOT_PROJECT_HOOK}" >> ".git/info/exclude" 2>/dev/null
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

const wrappersPath = () => path.join(CLAXEDO_DIR, WRAPPERS_JSON)

export const loadCustomWrappers = async () => {
  try {
    const raw = await fs.promises.readFile(wrappersPath(), "utf-8")
    const data = JSON.parse(raw) as { custom?: string[] }
    return normalizeWrappers(Array.isArray(data.custom) ? data.custom : [])
  } catch {
    return []
  }
}

export const saveCustomWrappers = async (custom: string[]) => {
  const next = normalizeWrappers(custom)
  await fs.promises.mkdir(CLAXEDO_DIR, { recursive: true, mode: 0o755 })
  await writeIfChanged(wrappersPath(), JSON.stringify({ custom: next }, null, 2) + "\n", 0o644, true)
  return next
}

export async function listWrapperAgents() {
  const custom = await loadCustomWrappers()
  const defaults = normalizeWrappers(DEFAULT_GENERIC_WRAPPERS)
  const all = normalizeWrappers([...defaults, ...custom, ...SHIMMED_BINARIES])
  return { defaults, custom, all }
}
