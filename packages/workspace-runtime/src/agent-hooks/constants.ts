/**
 * Agent Hooks Constants
 *
 * Directory paths, markers, file names, and shared templates.
 */

import * as path from "path"
import * as os from "os"
import { dataDir } from "../paths"

// ── Directories ───────────────────────────────────────────────────────────

export const CLAXEDO_DIR = dataDir()
export const BIN_DIR = path.join(CLAXEDO_DIR, "bin")
export const HOOKS_DIR = path.join(CLAXEDO_DIR, "hooks")
export const SHELL_DIR = path.join(CLAXEDO_DIR, "shell")
export const BASH_DIR = path.join(CLAXEDO_DIR, "bash")
export const OPENCODE_CONFIG_DIR = path.join(CLAXEDO_DIR, "opencode-config")
export const OPENCODE_PLUGIN_DIR = path.join(OPENCODE_CONFIG_DIR, "plugin")
export const OPENCODE_AGENT_DIR = path.join(OPENCODE_CONFIG_DIR, "agent")

// ── Markers ───────────────────────────────────────────────────────────────

export const WRAPPER_MARKER = "# Claxedo agent-wrapper v1"
export const WRAPPER_MARKER_CMD = "REM Claxedo agent-wrapper v1"
export const NOTIFY_MARKER = "# Claxedo agent notification hook v1"
export const NOTIFY_MARKER_JS = "// Claxedo agent notification hook v1"
export const SHELL_MARKER = "# Claxedo shell integration v1"
export const OPENCODE_PLUGIN_MARKER = "// Claxedo opencode plugin v1"

// ── File names ────────────────────────────────────────────────────────────

export const NOTIFY_SCRIPT = "notify.sh"
export const NOTIFY_SCRIPT_JS = "notify.js"
export const CODEX_NOTIFY = "codex-notify.sh"
export const CODEX_LOG_WATCHER = "codex-log-watcher.sh"
export const OPENCODE_PLUGIN = "claxedo-notify.js"
export const GEMINI_HOOK = "gemini-hook.sh"
export const CURSOR_HOOK = "cursor-hook.sh"
export const COPILOT_HOOK = "copilot-hook.sh"
export const COPILOT_PROJECT_HOOK = "claxedo-notify.json"
export const OPENCODE_JSONC = "opencode.jsonc"
export const DOC_AGENT_MD = "doc.md"
export const WRAPPERS_JSON = "wrappers.json"

// ── Agent lists ───────────────────────────────────────────────────────────

export const DEFAULT_GENERIC_WRAPPERS = ["aider", "goose", "cline", "pi"]
export const SHIMMED_BINARIES = new Set([
  "claude",
  "codex",
  "opencode",
  "gemini",
  "cursor",
  "cursor-agent",
  "copilot",
  "mastracode",
  "droid",
  "amp",
])

export const WRAPPER_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/

// ── External config paths ─────────────────────────────────────────────────
// These resolve to homedir on all platforms. Agents uniformly use ~/.<name>
// even on Windows (Claude, Cursor, Gemini all do this).

export const CLAUDE_MCP_PATH = path.join(os.homedir(), ".claude.json")
export const GEMINI_SETTINGS_PATH = path.join(os.homedir(), ".gemini", "settings.json")
export const CURSOR_HOOKS_PATH = path.join(os.homedir(), ".cursor", "hooks.json")
export const MASTRA_HOOKS_PATH = path.join(os.homedir(), ".mastracode", "hooks.json")
export const CURSOR_MCP_PATH = path.join(os.homedir(), ".cursor", "mcp.json")
export const DROID_SETTINGS_PATH = path.join(os.homedir(), ".factory", "settings.json")
export const CODEX_HOOKS_PATH = path.join(os.homedir(), ".codex", "hooks.json")

// ── Debug flag ────────────────────────────────────────────────────────────

export const DEBUG = process.env.CLAXEDO_DEBUG === "1"

// ── Shell templates (Unix) ────────────────────────────────────────────────

/**
 * Bash function that finds the real binary by walking PATH, skipping our
 * wrapper directory. Used in Unix wrapper scripts.
 */
export const FIND_REAL_BINARY = `
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
 * Windows .cmd equivalent: finds the real binary by walking %PATH%,
 * skipping our BIN_DIR. Sets %REAL_BIN% and jumps to :found.
 */
export const FIND_REAL_BINARY_CMD = `set "REAL_BIN="
for %%d in ("%PATH:;=" "%") do (
  if /I not "%%~d"=="{BIN_DIR}" (
    if exist "%%~d\\{BINARY_NAME}.exe" (
      set "REAL_BIN=%%~d\\{BINARY_NAME}.exe"
      goto :found
    )
    if exist "%%~d\\{BINARY_NAME}.cmd" (
      set "REAL_BIN=%%~d\\{BINARY_NAME}.cmd"
      goto :found
    )
  )
)
echo Claxedo: {BINARY_NAME} not found in PATH. Install it and ensure it is on PATH, then retry. >&2
exit /b 127
:found`
