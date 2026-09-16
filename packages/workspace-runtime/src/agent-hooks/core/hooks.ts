/**
 * Lifecycle Hooks
 *
 * Notify script, hook bridge generators, and hook config generation.
 */

import { NOTIFY_MARKER } from "./constants"
import {
  loadTemplate,
  shellQuote,
} from "./utils"

// ── Notify script ───────────────────────────────────────────────────────────

export function generateNotifyScript(port: number): string {
  return loadTemplate("notify.template.sh", {
    MARKER: NOTIFY_MARKER,
    PORT: String(port),
  })
}

// ── Hook bridges ────────────────────────────────────────────────────────────

export function generateAmpPlugin(): string {
  return `// Claxedo Amp lifecycle plugin v1
import { spawn } from "node:child_process"
import type { PluginAPI } from "@ampcode/plugin"

export default function (amp: PluginAPI) {
  const home = process.env.CLAXEDO_HOME_DIR
  if (!home || !process.env.CLAXEDO_TAB_ID) return
  const send = async (hook_event_name: string, event: unknown) => {
    await new Promise<void>((resolve) => {
      const child = spawn("bash", [home + "/hooks/notify.sh", "--harness=amp"], {
        env: { ...process.env, CLAXEDO_AGENT: "amp" },
        stdio: ["pipe", "ignore", "ignore"],
        timeout: 3000,
      })
      child.on("error", () => { amp.logger.log("Claxedo lifecycle transport failed"); resolve() })
      child.on("close", (code) => {
        if (code !== 0) amp.logger.log("Claxedo lifecycle delivery failed")
        resolve()
      })
      child.stdin.on("error", () => {})
      child.stdin.end(JSON.stringify({ hook_event_name, provider: "amp", event }))
    })
  }
  amp.on("agent.start", (event) => send("agent.start", event))
  amp.on("agent.end", (event) => send("agent.end", event))
}
`
}

export function generateGeminiHook(notifyPath: string): string {
  return loadTemplate("gemini-hook.template.sh", {
    MARKER: NOTIFY_MARKER,
    NOTIFY_PATH: notifyPath,
  })
}

export function generateAntigravityHook(notifyPath: string): string {
  return loadTemplate("antigravity-hook.template.sh", { MARKER: NOTIFY_MARKER, NOTIFY_PATH: notifyPath })
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
