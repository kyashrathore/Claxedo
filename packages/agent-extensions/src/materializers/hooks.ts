import fs from "fs/promises"
import path from "path"
import { readFileIfExists, writeFileAtomic } from "../fs-safe"

export type AgentHookRunner = "claude" | "codex" | "cursor" | "droid" | "gemini" | "mastra"

export type AgentHookMaterializationResult = {
  runner: AgentHookRunner
  component: "hooks"
  type: "hook"
  status: "applied" | "failed" | "skipped"
  path?: string
  reason?: string
}

export type MaterializeAgentHooksOptions = {
  homeDir: string
  notifyPath: string
  geminiHookPath: string
  cursorHookPath: string
  force?: boolean
  codexNativeHooks?: boolean
}

const NOTIFY_SCRIPT = "notify.sh"
const GEMINI_HOOK_SCRIPT = "gemini-hook.sh"
const CURSOR_HOOK_SCRIPT = "cursor-hook.sh"
const CLAUDE_NOTIFY_RELATIVE = `hooks/${NOTIFY_SCRIPT}`
const CLAUDE_DYNAMIC_NOTIFY = `$CLAXEDO_HOME_DIR/${CLAUDE_NOTIFY_RELATIVE}`
const MANAGED_HOOK_PATH_PATTERN = /\/\.claxedo(?:-[^/'"\s\\]+)?\//

function asRecord(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

// These are user-owned settings files (~/.claude/settings.json and friends).
// A parse failure must abort this runner's hook materialization instead of
// being read as "empty" — an empty read would rewrite the file with only the
// managed hooks, destroying everything else the user configured. applyHook
// reports the throw as a failed component for that runner.
async function readJson(filePath: string) {
  const raw = await readFileIfExists(filePath)
  if (raw === undefined || !raw.trim()) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch (err) {
    throw new Error(
      `Hook target config ${filePath} contains invalid JSON; fix it before materializing hooks (refusing to rewrite a file that cannot be parsed): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

async function writeIfChanged(filePath: string, content: string, mode: number, force: boolean) {
  if (!force) {
    const existing = await fs.readFile(filePath, "utf-8").catch(() => undefined)
    if (existing === content) return false
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o755 })
  await writeFileAtomic(filePath, content, mode)
  return true
}

function isManagedHookCommand(command: string | undefined, scriptName: string) {
  if (!command) return false
  const normalized = command.replaceAll("\\", "/")
  if (!normalized.includes(`/hooks/${scriptName}`)) return false
  return MANAGED_HOOK_PATH_PATTERN.test(normalized)
}

function reconcileManagedEntries<T>(input: {
  current: T[] | undefined
  desired: T[]
  isManaged: (entry: T) => boolean
  isEquivalent: (entry: T, desiredEntry: T) => boolean
}) {
  const existing = Array.isArray(input.current) ? input.current : []
  return [
    ...existing.filter((entry) => !input.isManaged(entry)),
    ...input.desired,
  ]
}

function targetPaths(homeDir: string) {
  return {
    claude: path.join(homeDir, ".claude", "settings.json"),
    codex: path.join(homeDir, ".codex", "hooks.json"),
    cursor: path.join(homeDir, ".cursor", "hooks.json"),
    droid: path.join(homeDir, ".factory", "settings.json"),
    gemini: path.join(homeDir, ".gemini", "settings.json"),
    mastra: path.join(homeDir, ".mastracode", "hooks.json"),
  }
}

export function getClaudeManagedHookCommand() {
  return `[ -n "$CLAXEDO_HOME_DIR" ] && [ -x "$CLAXEDO_HOME_DIR/${CLAUDE_NOTIFY_RELATIVE}" ] && "$CLAXEDO_HOME_DIR/${CLAUDE_NOTIFY_RELATIVE}" || true`
}

function isManagedClaudeHookCommand(command: string | undefined, notifyScriptPath: string) {
  return (
    command?.includes(notifyScriptPath) ||
    command?.includes(CLAUDE_DYNAMIC_NOTIFY) ||
    isManagedHookCommand(command, NOTIFY_SCRIPT)
  )
}

function removeManagedHooksFromDefinition(
  definition: Record<string, unknown>,
  isManaged: (command: string | undefined) => boolean,
) {
  const hooks = definition.hooks
  if (!Array.isArray(hooks)) return definition
  const filtered = hooks.filter((hook) => !isManaged(asRecord(hook).command as string | undefined))
  if (filtered.length === hooks.length) return definition
  if (filtered.length === 0) return null
  return { ...definition, hooks: filtered }
}

async function upsertNestedHookSettings(input: {
  file: string
  notifyPath: string
  force: boolean
  events: { event: string; definition: Record<string, unknown> }[]
  isManaged: (command: string | undefined) => boolean
}) {
  const existing = asRecord(await readJson(input.file))
  if (!existing.hooks || typeof existing.hooks !== "object") existing.hooks = {}
  const hooks = existing.hooks as Record<string, unknown>

  for (const item of input.events) {
    const current = hooks[item.event]
    if (Array.isArray(current)) {
      hooks[item.event] = [
        ...current.flatMap((def) => {
          const cleaned = removeManagedHooksFromDefinition(asRecord(def), input.isManaged)
          return cleaned ? [cleaned] : []
        }),
        item.definition,
      ]
      continue
    }
    hooks[item.event] = [item.definition]
  }

  await writeIfChanged(input.file, JSON.stringify(existing, null, 2) + "\n", 0o644, input.force)
}

async function materializeClaude(input: { file: string; notifyPath: string; force: boolean }) {
  const command = getClaudeManagedHookCommand()
  await upsertNestedHookSettings({
    ...input,
    events: [
      { event: "UserPromptSubmit", definition: { hooks: [{ type: "command", command }] } },
      { event: "Stop", definition: { hooks: [{ type: "command", command }] } },
      { event: "SubagentStop", definition: { hooks: [{ type: "command", command }] } },
      { event: "PostToolUse", definition: { matcher: "*", hooks: [{ type: "command", command }] } },
      { event: "PostToolUseFailure", definition: { matcher: "*", hooks: [{ type: "command", command }] } },
      { event: "PermissionRequest", definition: { matcher: "*", hooks: [{ type: "command", command }] } },
    ],
    isManaged: (command) => isManagedClaudeHookCommand(command, input.notifyPath),
  })
}

async function materializeDroid(input: { file: string; notifyPath: string; force: boolean }) {
  await upsertNestedHookSettings({
    ...input,
    events: [
      { event: "UserPromptSubmit", definition: { hooks: [{ type: "command", command: input.notifyPath }] } },
      { event: "Notification", definition: { hooks: [{ type: "command", command: input.notifyPath }] } },
      { event: "Stop", definition: { hooks: [{ type: "command", command: input.notifyPath }] } },
      { event: "PostToolUse", definition: { matcher: "*", hooks: [{ type: "command", command: input.notifyPath }] } },
    ],
    isManaged: (command) => command?.includes(input.notifyPath) || isManagedHookCommand(command, NOTIFY_SCRIPT),
  })
}

function pruneCodexHooks(hooks: Record<string, unknown>, notifyPath: string) {
  for (const [name, current] of Object.entries(hooks)) {
    if (!Array.isArray(current)) continue
    const entries = current.flatMap((def) => {
      const next = removeManagedHooksFromDefinition(asRecord(def), (cmd) =>
        cmd?.includes(notifyPath) || isManagedHookCommand(cmd, NOTIFY_SCRIPT),
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

async function materializeCodex(input: { file: string; notifyPath: string; force: boolean; native: boolean }) {
  const existing = asRecord(await readJson(input.file))
  if (!existing.hooks && !input.native) return
  if (!existing.hooks || typeof existing.hooks !== "object") existing.hooks = {}
  const hooks = existing.hooks as Record<string, unknown>
  pruneCodexHooks(hooks, input.notifyPath)

  if (input.native) {
    const events = [
      { event: "SessionStart", definition: { hooks: [{ type: "command", command: input.notifyPath }] } },
      { event: "UserPromptSubmit", definition: { hooks: [{ type: "command", command: input.notifyPath }] } },
      { event: "Stop", definition: { hooks: [{ type: "command", command: input.notifyPath }] } },
    ]
    for (const item of events) {
      const current = hooks[item.event]
      hooks[item.event] = Array.isArray(current) ? [...current, item.definition] : [item.definition]
    }
  }

  if (Object.keys(hooks).length === 0) delete existing.hooks
  await writeIfChanged(input.file, JSON.stringify(existing, null, 2) + "\n", 0o644, input.force)
}

async function materializeGemini(input: { file: string; hookPath: string; force: boolean }) {
  const root = asRecord(await readJson(input.file))
  if (!root.hooks || typeof root.hooks !== "object") root.hooks = {}
  const hooks = root.hooks as Record<string, unknown>

  for (const event of ["BeforeAgent", "AfterAgent", "AfterTool"]) {
    hooks[event] = reconcileManagedEntries({
      current: hooks[event] as unknown[] | undefined,
      desired: [{ hooks: [{ type: "command", command: input.hookPath }] }],
      isManaged: (entry) => {
        const nested = Array.isArray(asRecord(entry).hooks) ? asRecord(entry).hooks as unknown[] : []
        return nested.some((hook) => {
          const command = asRecord(hook).command as string | undefined
          return command === input.hookPath || isManagedHookCommand(command, GEMINI_HOOK_SCRIPT)
        })
      },
      isEquivalent: (a, b) => JSON.stringify(asRecord(a).hooks ?? []) === JSON.stringify(asRecord(b).hooks ?? []),
    })
  }

  await writeIfChanged(input.file, JSON.stringify(root, null, 2) + "\n", 0o644, input.force)
}

async function materializeCursor(input: { file: string; hookPath: string; force: boolean }) {
  const root = asRecord(await readJson(input.file))
  if (typeof root.version !== "number") root.version = 1
  if (!root.hooks || typeof root.hooks !== "object") root.hooks = {}
  const hooks = root.hooks as Record<string, unknown>
  const desired: Record<string, { command: string }> = {
    beforeSubmitPrompt: { command: `${input.hookPath} Start` },
    stop: { command: `${input.hookPath} Stop` },
    beforeShellExecution: { command: `${input.hookPath} PermissionRequest` },
    beforeMCPExecution: { command: `${input.hookPath} PermissionRequest` },
  }

  for (const [event, entry] of Object.entries(desired)) {
    hooks[event] = reconcileManagedEntries({
      current: hooks[event] as unknown[] | undefined,
      desired: [entry],
      isManaged: (item) => {
        const command = asRecord(item).command as string | undefined
        return command?.includes(input.hookPath) || isManagedHookCommand(command, CURSOR_HOOK_SCRIPT)
      },
      isEquivalent: (a, b) => asRecord(a).command === asRecord(b).command,
    })
  }

  await writeIfChanged(input.file, JSON.stringify(root, null, 2) + "\n", 0o644, input.force)
}

async function materializeMastra(input: { file: string; notifyPath: string; force: boolean }) {
  const root = asRecord(await readJson(input.file))
  const command = `bash ${shellQuote(input.notifyPath)}`

  for (const event of ["UserPromptSubmit", "Stop", "PostToolUse"]) {
    root[event] = reconcileManagedEntries({
      current: root[event] as unknown[] | undefined,
      desired: [{ type: "command", command }],
      isManaged: (entry) => {
        const current = asRecord(entry).command as string | undefined
        return current?.includes(input.notifyPath) || isManagedHookCommand(current, NOTIFY_SCRIPT)
      },
      isEquivalent: (a, b) => asRecord(a).command === asRecord(b).command,
    })
  }

  await writeIfChanged(input.file, JSON.stringify(root, null, 2) + "\n", 0o644, input.force)
}

async function applyHook(input: {
  runner: AgentHookRunner
  file: string
  run: () => Promise<void>
}): Promise<AgentHookMaterializationResult> {
  try {
    await input.run()
    return { runner: input.runner, component: "hooks", type: "hook", status: "applied", path: input.file }
  } catch (error) {
    return {
      runner: input.runner,
      component: "hooks",
      type: "hook",
      status: "failed",
      path: input.file,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function materializeAgentHooks(input: MaterializeAgentHooksOptions) {
  const files = targetPaths(input.homeDir)
  const force = input.force ?? false
  const codexNativeHooks = input.codexNativeHooks ?? false
  return Promise.all([
    applyHook({
      runner: "claude",
      file: files.claude,
      run: () => materializeClaude({ file: files.claude, notifyPath: input.notifyPath, force }),
    }),
    applyHook({
      runner: "codex",
      file: files.codex,
      run: () => materializeCodex({ file: files.codex, notifyPath: input.notifyPath, force, native: codexNativeHooks }),
    }),
    applyHook({
      runner: "droid",
      file: files.droid,
      run: () => materializeDroid({ file: files.droid, notifyPath: input.notifyPath, force }),
    }),
    applyHook({
      runner: "gemini",
      file: files.gemini,
      run: () => materializeGemini({ file: files.gemini, hookPath: input.geminiHookPath, force }),
    }),
    applyHook({
      runner: "cursor",
      file: files.cursor,
      run: () => materializeCursor({ file: files.cursor, hookPath: input.cursorHookPath, force }),
    }),
    applyHook({
      runner: "mastra",
      file: files.mastra,
      run: () => materializeMastra({ file: files.mastra, notifyPath: input.notifyPath, force }),
    }),
  ])
}
