/**
 * Shell Integration
 *
 * Shell config generators (zsh, bash, fish), terminal environment variables,
 * and shell argument helpers.
 *
 * Key features:
 * - Env save/restore: prevents user RC files from overriding CLAXEDO_* vars
 * - Precmd hook: re-asserts BIN_DIR in PATH after mise/asdf reconstructs it
 * - Shell-ready marker: OSC 777 escape sequence for terminal readiness detection
 * - Fish support: native function wrappers with $argv handling
 */

import * as fs from "fs"
import * as path from "path"
import { Log } from "../../log"
import {
  CLAXEDO_DIR,
  BIN_DIR,
  BASH_DIR,
  DEBUG,
  SHELL_DIR,
  SHELL_MARKER,
  SHIMMED_BINARIES,
} from "./constants"
import { loadTemplate, shellQuote } from "./utils"

const log = Log.create({ service: "agent-hooks" })

// ── Env save/restore snippets ──────────────────────────────────────────────

/**
 * Shell snippet to save all CLAXEDO_* env vars before sourcing user RC files.
 * Used in tandem with ENV_RESTORE to prevent user shell configs from
 * overriding Claxedo-managed environment variables.
 */
const ENV_SAVE = `_claxedo_saved_env="$(export -p 2>/dev/null | grep ' CLAXEDO_')"`;

/**
 * Shell snippet to restore previously saved CLAXEDO_* env vars after
 * sourcing user RC files.
 */
const ENV_RESTORE = `eval "$_claxedo_saved_env" 2>/dev/null || true`;

// ── Path management ────────────────────────────────────────────────────────

/** Idempotently prepend BIN_DIR to PATH. */
function buildPathPrepend(binDir: string): string {
  return `_claxedo_prepend_bin() {
  case ":$PATH:" in
    *:${shellQuote(binDir)}:*) ;;
    *) export PATH=${shellQuote(binDir)}:"$PATH" ;;
  esac
}
_claxedo_prepend_bin`
}

/**
 * Zsh precmd hook that re-asserts BIN_DIR in PATH.
 * Tools like mise/asdf register precmd hooks that reconstruct PATH,
 * which can remove our BIN_DIR.
 */
function buildZshPrecmdHook(binDir: string): string {
  return `typeset -ga precmd_functions 2>/dev/null || true
_claxedo_ensure_path() {
  case ":$PATH:" in
    *:${shellQuote(binDir)}:*) ;;
    *) PATH=${shellQuote(binDir)}:"$PATH" ;;
  esac
}
{
  # Keep our hook last so it wins over other PATH-mutating precmd hooks.
  precmd_functions=(\${precmd_functions:#_claxedo_ensure_path} _claxedo_ensure_path)
} 2>/dev/null || true`
}

// ── Fish helpers ───────────────────────────────────────────────────────────

function escapeFishDoubleQuoted(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
}

function buildFishManagedPrelude(binDir: string): string {
  const escaped = escapeFishDoubleQuoted(binDir)
  return [...SHIMMED_BINARIES].map(
    (name) =>
      `functions -q ${name}; and functions -e ${name}
function ${name}
  set -l _claxedo_wrapper "${escaped}/${name}"
  if test -x "$_claxedo_wrapper"; and not test -d "$_claxedo_wrapper"
    "$_claxedo_wrapper" $argv
  else
    command ${name} $argv
  end
end`,
  ).join("\n")
}

// ── Shell config generators ────────────────────────────────────────────────

const shellDirQuoted = shellQuote(SHELL_DIR)

const commonVars = {
  MARKER: SHELL_MARKER,
  SHELL_DIR_QUOTED: shellDirQuoted,
  ENV_SAVE,
  ENV_RESTORE,
  PATH_PREPEND: buildPathPrepend(BIN_DIR),
  PRECMD_HOOK: buildZshPrecmdHook(BIN_DIR),
}

export function generateZshenv(): string {
  return loadTemplate("zshenv.template.sh", commonVars)
}

export function generateZshprofile(): string {
  return loadTemplate("zshprofile.template.sh", commonVars)
}

export function generateZshrc(): string {
  return loadTemplate("zshrc.template.sh", commonVars)
}

export function generateZshlogin(): string {
  return loadTemplate("zshlogin.template.sh", commonVars)
}

export function generateBashrc(): string {
  return loadTemplate("bashrc.template.sh", {
    MARKER: SHELL_MARKER,
    ENV_SAVE,
    ENV_RESTORE,
    PATH_PREPEND: buildPathPrepend(BIN_DIR),
  })
}

// ── Terminal environment ───────────────────────────────────────────────────

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
    CLAXEDO_HOME_DIR: CLAXEDO_DIR,
    CLAXEDO_TAB_ID: tabId,
    CLAXEDO_TERMINAL_ID: terminalId,
    CLAXEDO_WORKSPACE_ID: workspaceId,
    CLAXEDO_PORT: String(port),
    CLAXEDO_MCP_TOOL: "tab_context",
    CLAXEDO_MCP_HINT:
      "Use claxedo-mcp tab_context to fetch current tab and named pane context. Defaults resolve from CLAXEDO_TAB_ID/CLAXEDO_TERMINAL_ID.",
    CLAXEDO_TAB_PROMPT: `Current tab is ${tabId}. Call the MCP tool tab_context to load full tab state, or tab_context pane_name=#doc for named pane context.`,
  }

  if (DEBUG) {
    env.CLAXEDO_DEBUG = "1"
  }

  const base = process.env.PATH || ""
  const parts = base.split(":").filter(Boolean)
  const has = parts.includes(BIN_DIR)
  env.PATH = has ? base : `${BIN_DIR}${base ? ":" : ""}${base}`

  const shellName = shell?.split("/").pop() || ""
  if (shellName === "zsh" || shellName.includes("zsh")) {
    env.ZDOTDIR = SHELL_DIR
    env.CLAXEDO_ORIG_ZDOTDIR = process.env.ZDOTDIR || process.env.HOME || ""
    if (DEBUG) {
      log.info("Shell integration: zsh", { ZDOTDIR: env.ZDOTDIR })
    }
  } else if (shellName === "bash" || shellName.includes("bash")) {
    // Bash ignores --rcfile when -c is present; env vars are enough
    if (DEBUG) {
      log.info("Shell integration: bash")
    }
  } else {
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
 * Shell args for interactive terminal sessions.
 * Zsh uses ZDOTDIR, bash uses --rcfile, fish uses --init-command.
 */
export function getShellArgs(shell: string): string[] {
  const shellName = shell?.split("/").pop() || ""
  if (shellName === "bash" || shellName.includes("bash")) {
    return ["--rcfile", path.join(BASH_DIR, "rcfile")]
  }
  if (shellName === "fish") {
    const escaped = escapeFishDoubleQuoted(BIN_DIR)
    return [
      "-l",
      "--init-command",
      `set -l _claxedo_bin "${escaped}"; contains -- "$_claxedo_bin" $PATH; or set -gx PATH "$_claxedo_bin" $PATH; function _claxedo_shell_ready --on-event fish_prompt; printf '\\033]777;claxedo-shell-ready\\007'; functions -e _claxedo_shell_ready; end`,
    ]
  }
  if (["zsh", "sh", "ksh"].includes(shellName)) {
    return ["-l"]
  }
  return []
}

/**
 * Shell args for non-interactive command execution (-c).
 * Sources profiles inline because zsh skips .zshrc for non-interactive shells
 * and bash ignores --rcfile when -c is present.
 */
export function getCommandShellArgs(shell: string, command: string): string[] {
  const shellName = shell?.split("/").pop() || ""
  const zshRc = path.join(SHELL_DIR, ".zshrc")
  const bashRcfile = path.join(BASH_DIR, "rcfile")

  if (shellName === "zsh" && fs.existsSync(zshRc)) {
    return ["-lc", `source ${shellQuote(zshRc)} &&\n${command}`]
  }
  if (shellName === "bash" && fs.existsSync(bashRcfile)) {
    return ["-c", `source ${shellQuote(bashRcfile)} &&\n${command}`]
  }
  return ["-lc", command]
}
