/**
 * Lifecycle Hooks
 *
 * Notify script, hook bridge generators, and hook config generation.
 */

import {
  CLAXEDO_DIR,
  NOTIFY_MARKER,
} from "./constants"
import {
  loadTemplate,
  shellQuote,
} from "./utils"

// ── Notify script ───────────────────────────────────────────────────────────

export function generateNotifyScript(port: number, root = CLAXEDO_DIR): string {
  return loadTemplate("notify.template.sh", {
    MARKER: NOTIFY_MARKER,
    PORT: String(port),
  })
}

// ── Hook bridges ────────────────────────────────────────────────────────────

export function generateGeminiHook(notifyPath: string): string {
  return loadTemplate("gemini-hook.template.sh", {
    MARKER: NOTIFY_MARKER,
    NOTIFY_PATH: notifyPath,
  })
}

export function generateCursorHook(notifyPath: string): string {
  return loadTemplate("cursor-hook.template.sh", {
    MARKER: NOTIFY_MARKER,
    NOTIFY_PATH: notifyPath,
  })
}

export function generateCopilotHook(notifyPath: string): string {
  return loadTemplate("copilot-hook.template.sh", {
    MARKER: NOTIFY_MARKER,
    NOTIFY_PATH: notifyPath,
  })
}

export function generateCodexLogWatcher(notifyPath: string): string {
  return loadTemplate("codex-log-watcher.template.sh", {
    MARKER: NOTIFY_MARKER,
    CODEX_NOTIFY_PATH: notifyPath,
  })
}

export function generateCodexNotify(notifyPath: string, watcherPath: string): string {
  return loadTemplate("codex-notify.template.sh", {
    MARKER: NOTIFY_MARKER,
    CODEX_NOTIFY_PATH: notifyPath,
    CODEX_WATCHER_PATH: watcherPath,
  })
}

// ── Hook config generation ──────────────────────────────────────────────────

export function generateCopilotProjectHooks(copilotHookPath: string): string {
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
