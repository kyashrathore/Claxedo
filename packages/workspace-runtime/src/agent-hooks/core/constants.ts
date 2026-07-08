/**
 * Agent Hooks Core Constants
 *
 * Directory paths, generic markers, file names, and shared templates.
 */

import * as path from "path"
import { dataDir } from "../../paths"

export const CLAXEDO_DIR = dataDir()
export const BIN_DIR = path.join(CLAXEDO_DIR, "bin")
export const HOOKS_DIR = path.join(CLAXEDO_DIR, "hooks")
export const SHELL_DIR = path.join(CLAXEDO_DIR, "shell")
export const BASH_DIR = path.join(CLAXEDO_DIR, "bash")

export const WRAPPER_MARKER = "# Claxedo agent-wrapper v1"
export const NOTIFY_MARKER = "# Claxedo agent notification hook v1"
export const SHELL_MARKER = "# Claxedo shell integration v1"

export const NOTIFY_SCRIPT = "notify.sh"
export const CODEX_NOTIFY = "codex-notify.sh"
export const CODEX_LOG_WATCHER = "codex-log-watcher.sh"
export const GEMINI_HOOK = "gemini-hook.sh"
export const CURSOR_HOOK = "cursor-hook.sh"
export const COPILOT_HOOK = "copilot-hook.sh"
export const COPILOT_PROJECT_HOOK = "claxedo-notify.json"
export const WRAPPERS_JSON = "wrappers.json"

export const DEFAULT_GENERIC_WRAPPERS = ["amp", "aider", "goose", "cline"]
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
])

export const WRAPPER_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/

export const FIND_REAL_BINARY = `
find_real_binary() {
  local name="$1"
  local IFS=':'
  for dir in $PATH; do
    [ -z "$dir" ] && continue
    case "$dir" in
      "${BIN_DIR}"|"$HOME/.workspace-runtime/bin") continue ;;
    esac
    if [ -x "$dir/$name" ] && [ ! -d "$dir/$name" ]; then
      printf "%s\\n" "$dir/$name"
      return 0
    fi
  done
  return 1
}
`
