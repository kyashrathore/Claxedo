/**
 * Lifecycle Hooks
 *
 * Notify script, hook bridge generators, hook config generation,
 * and upsert into external agent config files.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  CLAXEDO_DIR,
  HOOKS_DIR,
  NOTIFY_MARKER,
  NOTIFY_SCRIPT,
  GEMINI_SETTINGS_PATH,
  CURSOR_HOOKS_PATH,
  MASTRA_HOOKS_PATH,
  DROID_SETTINGS_PATH,
  CODEX_HOOKS_PATH,
} from "./constants"
import {
  asRecord,
  isManagedHookCommand,
  loadTemplate,
  readJSON,
  reconcileManagedEntries,
  shellQuote,
  writeIfChanged,
} from "./utils"

// ── Notify script ───────────────────────────────────────────────────────────

export function generateNotifyScript(port: number): string {
  return loadTemplate("notify.template.sh", {
    MARKER: NOTIFY_MARKER,
    LOG_FILE: path.join(CLAXEDO_DIR, "debug.log"),
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

// ── Claude settings.json merge ─────────────────────────────────────────────

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json")
const CLAUDE_NOTIFY_RELATIVE = `hooks/${NOTIFY_SCRIPT}`
const CLAUDE_DYNAMIC_NOTIFY = `$CLAXEDO_HOME_DIR/${CLAUDE_NOTIFY_RELATIVE}`

/**
 * Returns the shell command written into Claude's global hook config.
 * The notify path is resolved at runtime from CLAXEDO_HOME_DIR so one
 * shared ~/.claude/settings.json works for both dev and prod installs.
 */
export function getClaudeManagedHookCommand(): string {
  return `[ -n "$CLAXEDO_HOME_DIR" ] && [ -x "$CLAXEDO_HOME_DIR/${CLAUDE_NOTIFY_RELATIVE}" ] && "$CLAXEDO_HOME_DIR/${CLAUDE_NOTIFY_RELATIVE}" || true`
}

function isManagedClaudeHookCommand(command: string | undefined, notifyScriptPath: string): boolean {
  return (
    command?.includes(notifyScriptPath) ||
    command?.includes(CLAUDE_DYNAMIC_NOTIFY) ||
    isManagedHookCommand(command, NOTIFY_SCRIPT)
  )
}

function removeManagedHooksFromDefinition(
  definition: Record<string, unknown>,
  isManaged: (command: string | undefined) => boolean,
): Record<string, unknown> | null {
  const hooks = definition.hooks
  if (!Array.isArray(hooks)) return definition

  const filtered = hooks.filter((hook) => !isManaged(asRecord(hook).command as string | undefined))
  if (filtered.length === hooks.length) return definition
  if (filtered.length === 0) return null
  return { ...definition, hooks: filtered }
}

/**
 * Merge Claxedo hook definitions into ~/.claude/settings.json.
 * Preserves user-defined hooks. Works without the binary wrapper in PATH.
 */
export async function upsertClaudeSettings(notifyScriptPath: string, force: boolean): Promise<void> {
  const existing = asRecord(await readJSON(CLAUDE_SETTINGS_PATH))
  const managedHookCommand = getClaudeManagedHookCommand()

  if (!existing.hooks || typeof existing.hooks !== "object") {
    existing.hooks = {}
  }
  const hooks = existing.hooks as Record<string, unknown>

  const managedEvents: { event: string; definition: Record<string, unknown> }[] = [
    { event: "UserPromptSubmit", definition: { hooks: [{ type: "command", command: managedHookCommand }] } },
    { event: "Stop", definition: { hooks: [{ type: "command", command: managedHookCommand }] } },
    { event: "SubagentStop", definition: { hooks: [{ type: "command", command: managedHookCommand }] } },
    { event: "PostToolUse", definition: { matcher: "*", hooks: [{ type: "command", command: managedHookCommand }] } },
    { event: "PostToolUseFailure", definition: { matcher: "*", hooks: [{ type: "command", command: managedHookCommand }] } },
    { event: "PermissionRequest", definition: { matcher: "*", hooks: [{ type: "command", command: managedHookCommand }] } },
  ]

  for (const { event, definition } of managedEvents) {
    const current = hooks[event]
    if (Array.isArray(current)) {
      const filtered = current.flatMap((def) => {
        const cleaned = removeManagedHooksFromDefinition(
          asRecord(def),
          (cmd) => isManagedClaudeHookCommand(cmd, notifyScriptPath),
        )
        return cleaned ? [cleaned] : []
      })
      filtered.push(definition)
      hooks[event] = filtered
    } else {
      hooks[event] = [definition]
    }
  }

  await fs.promises.mkdir(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true, mode: 0o755 })
  await writeIfChanged(CLAUDE_SETTINGS_PATH, JSON.stringify(existing, null, 2) + "\n", 0o644, force)
}

// ── Droid ~/.factory/settings.json merge ───────────────────────────────────

function isManagedDroidHookCommand(command: string | undefined, notifyScriptPath: string): boolean {
  return (
    command?.includes(notifyScriptPath) ||
    isManagedHookCommand(command, NOTIFY_SCRIPT)
  )
}

/**
 * Merge Claxedo hook definitions into ~/.factory/settings.json.
 * Droid (Factory) uses the same nested hook structure as Claude.
 */
export async function upsertDroidSettings(notifyScriptPath: string, force: boolean): Promise<void> {
  const existing = asRecord(await readJSON(DROID_SETTINGS_PATH))

  if (!existing.hooks || typeof existing.hooks !== "object") {
    existing.hooks = {}
  }
  const hooks = existing.hooks as Record<string, unknown>

  const managedEvents: { event: string; definition: Record<string, unknown> }[] = [
    { event: "UserPromptSubmit", definition: { hooks: [{ type: "command", command: notifyScriptPath }] } },
    { event: "Notification", definition: { hooks: [{ type: "command", command: notifyScriptPath }] } },
    { event: "Stop", definition: { hooks: [{ type: "command", command: notifyScriptPath }] } },
    { event: "PostToolUse", definition: { matcher: "*", hooks: [{ type: "command", command: notifyScriptPath }] } },
  ]

  for (const { event, definition } of managedEvents) {
    const current = hooks[event]
    if (Array.isArray(current)) {
      const filtered = current.flatMap((def) => {
        const cleaned = removeManagedHooksFromDefinition(
          asRecord(def),
          (cmd) => isManagedDroidHookCommand(cmd, notifyScriptPath),
        )
        return cleaned ? [cleaned] : []
      })
      filtered.push(definition)
      hooks[event] = filtered
    } else {
      hooks[event] = [definition]
    }
  }

  await fs.promises.mkdir(path.dirname(DROID_SETTINGS_PATH), { recursive: true, mode: 0o755 })
  await writeIfChanged(DROID_SETTINGS_PATH, JSON.stringify(existing, null, 2) + "\n", 0o644, force)
}

// ── Codex ~/.codex/hooks.json merge ────────────────────────────────────────

function isManagedCodexHookCommand(command: string | undefined, notifyScriptPath: string): boolean {
  return (
    command?.includes(notifyScriptPath) ||
    isManagedHookCommand(command, NOTIFY_SCRIPT)
  )
}

function pruneCodexHooks(hooks: Record<string, unknown>, notifyScriptPath: string) {
  for (const [name, current] of Object.entries(hooks)) {
    if (!Array.isArray(current)) continue
    const entries = current.flatMap((def) => {
      const next = removeManagedHooksFromDefinition(
        asRecord(def),
        (cmd) => isManagedCodexHookCommand(cmd, notifyScriptPath),
      )
      return next ? [next] : []
    })
    if (entries.length === 0) {
      delete hooks[name]
      continue
    }
    hooks[name] = entries
  }
}

/**
 * Register hooks directly in ~/.codex/hooks.json as durable fallback.
 * Codex hooks.json uses the same nested structure as Claude/Droid settings.
 */
export async function upsertCodexHooks(notifyScriptPath: string, force: boolean): Promise<void> {
  const existing = asRecord(await readJSON(CODEX_HOOKS_PATH))

  if (!existing.hooks || typeof existing.hooks !== "object") {
    existing.hooks = {}
  }
  const hooks = existing.hooks as Record<string, unknown>

  pruneCodexHooks(hooks, notifyScriptPath)

  const managedEvents: { event: string; definition: Record<string, unknown> }[] = [
    { event: "SessionStart", definition: { hooks: [{ type: "command", command: notifyScriptPath }] } },
    { event: "UserPromptSubmit", definition: { hooks: [{ type: "command", command: notifyScriptPath }] } },
    { event: "Stop", definition: { hooks: [{ type: "command", command: notifyScriptPath }] } },
  ]

  for (const { event, definition } of managedEvents) {
    const current = hooks[event]
    if (Array.isArray(current)) {
      current.push(definition)
    } else {
      hooks[event] = [definition]
    }
  }

  await fs.promises.mkdir(path.dirname(CODEX_HOOKS_PATH), { recursive: true, mode: 0o755 })
  await writeIfChanged(CODEX_HOOKS_PATH, JSON.stringify(existing, null, 2) + "\n", 0o644, force)
}

export async function cleanupCodexHooks(notifyScriptPath: string, force: boolean): Promise<void> {
  const existing = asRecord(await readJSON(CODEX_HOOKS_PATH))
  if (!existing.hooks || typeof existing.hooks !== "object") return

  const hooks = existing.hooks as Record<string, unknown>
  pruneCodexHooks(hooks, notifyScriptPath)

  if (Object.keys(hooks).length === 0) {
    delete existing.hooks
  }

  await fs.promises.mkdir(path.dirname(CODEX_HOOKS_PATH), { recursive: true, mode: 0o755 })
  await writeIfChanged(CODEX_HOOKS_PATH, JSON.stringify(existing, null, 2) + "\n", 0o644, force)
}

// ── Gemini ~/.gemini/settings.json hook upsert ─────────────────────────────

const GEMINI_HOOK_SCRIPT = "gemini-hook.sh"

export const upsertGeminiHooks = async (hookPath: string, force: boolean) => {
  await fs.promises.mkdir(path.dirname(GEMINI_SETTINGS_PATH), { recursive: true, mode: 0o755 })
  const root = asRecord(await readJSON(GEMINI_SETTINGS_PATH))
  if (!root.hooks || typeof root.hooks !== "object") root.hooks = {}
  const hooks = root.hooks as Record<string, unknown>

  for (const event of ["BeforeAgent", "AfterAgent", "AfterTool"]) {
    const current = hooks[event] as unknown[] | undefined
    const desired = [{ hooks: [{ type: "command", command: hookPath }] }]
    const { entries } = reconcileManagedEntries({
      current,
      desired,
      isManaged: (entry) => {
        const def = asRecord(entry)
        const nested = Array.isArray(def.hooks) ? def.hooks : []
        return nested.some((hook) => {
          const h = asRecord(hook)
          return (
            h.command === hookPath ||
            isManagedHookCommand(h.command as string | undefined, GEMINI_HOOK_SCRIPT)
          )
        })
      },
      isEquivalent: (a, b) =>
        JSON.stringify(asRecord(a).hooks ?? []) === JSON.stringify(asRecord(b).hooks ?? []),
    })
    hooks[event] = entries
  }

  root.hooks = hooks
  await writeIfChanged(GEMINI_SETTINGS_PATH, JSON.stringify(root, null, 2) + "\n", 0o644, force)
}

// ── Cursor ~/.cursor/hooks.json upsert ─────────────────────────────────────

const CURSOR_HOOK_SCRIPT = "cursor-hook.sh"

export const upsertCursorHooks = async (hookPath: string, force: boolean) => {
  await fs.promises.mkdir(path.dirname(CURSOR_HOOKS_PATH), { recursive: true, mode: 0o755 })
  const root = asRecord(await readJSON(CURSOR_HOOKS_PATH))
  if (typeof root.version !== "number") root.version = 1
  if (!root.hooks || typeof root.hooks !== "object") root.hooks = {}
  const hooks = root.hooks as Record<string, unknown>

  const ourHooks: Record<string, { command: string }> = {
    beforeSubmitPrompt: { command: `${hookPath} Start` },
    stop: { command: `${hookPath} Stop` },
    beforeShellExecution: { command: `${hookPath} PermissionRequest` },
    beforeMCPExecution: { command: `${hookPath} PermissionRequest` },
  }

  for (const [event, ourEntry] of Object.entries(ourHooks)) {
    const current = hooks[event] as unknown[] | undefined
    const { entries } = reconcileManagedEntries({
      current,
      desired: [ourEntry],
      isManaged: (entry) => {
        const cmd = asRecord(entry).command as string | undefined
        return (
          cmd?.includes(hookPath) ||
          isManagedHookCommand(cmd, CURSOR_HOOK_SCRIPT)
        )
      },
      isEquivalent: (a, b) => asRecord(a).command === asRecord(b).command,
    })
    hooks[event] = entries
  }

  root.hooks = hooks
  await writeIfChanged(CURSOR_HOOKS_PATH, JSON.stringify(root, null, 2) + "\n", 0o644, force)
}

// ── Mastra ~/.mastracode/hooks.json upsert ─────────────────────────────────

export const upsertMastraHooks = async (notifyPath: string, force: boolean) => {
  await fs.promises.mkdir(path.dirname(MASTRA_HOOKS_PATH), { recursive: true, mode: 0o755 })
  const root = asRecord(await readJSON(MASTRA_HOOKS_PATH))
  const command = `bash ${shellQuote(notifyPath)}`

  for (const event of ["UserPromptSubmit", "Stop", "PostToolUse"]) {
    const current = root[event] as unknown[] | undefined
    const { entries } = reconcileManagedEntries({
      current,
      desired: [{ type: "command", command }],
      isManaged: (entry) => {
        const cmd = asRecord(entry).command as string | undefined
        return (
          cmd?.includes(notifyPath) ||
          isManagedHookCommand(cmd, NOTIFY_SCRIPT)
        )
      },
      isEquivalent: (a, b) => asRecord(a).command === asRecord(b).command,
    })
    root[event] = entries
  }

  await writeIfChanged(MASTRA_HOOKS_PATH, JSON.stringify(root, null, 2) + "\n", 0o644, force)
}
