import fs from "fs/promises"
import path from "path"
import { asRecordOrEmpty } from "@claxedo/helpers/guards"
import { writeIfChanged as writeFileAtomically } from "./core/utils"
import { arr, rec, str } from "../json-value"
import { generateAmpPlugin, generateAntigravityHook } from "./core/hooks"

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch (error) {
    if (str(rec(error)?.code) === "ENOENT") return undefined
    throw error
  }
}

export type AgentHookRunner = "claude" | "codex" | "cursor" | "droid" | "gemini" | "mastra" | "amp" | "antigravity"

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

/**
 * The record at `key`, creating and installing an empty one when the file has
 * no usable node there. Returns the SAME object that is now on `root`, so the
 * caller mutates the settings tree it is about to write back.
 */
function recordAt(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = rec(root[key])
  if (existing) return existing
  const created: Record<string, unknown> = {}
  root[key] = created
  return created
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
      `Hook target config ${filePath} contains invalid JSON; fix it before materializing hooks (refusing to rewrite a file that cannot be parsed): ${err instanceof Error ? err.message : String(err)}`, { cause: err },
    )
  }
}

async function writeIfChanged(filePath: string, content: string, mode: number, force: boolean) {
  if (!force) {
    const existing = await fs.readFile(filePath, "utf-8").catch(() => undefined)
    if (existing === content) return false
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o755 })
  await writeFileAtomically(filePath, content, mode, true)
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
    antigravity: path.join(homeDir, ".gemini", "config", "hooks.json"),
    amp: path.join(homeDir, ".config", "amp", "plugins", "claxedo-lifecycle.ts"),
    claude: path.join(homeDir, ".claude", "settings.json"),
    codex: path.join(homeDir, ".codex", "hooks.json"),
    cursor: path.join(homeDir, ".cursor", "hooks.json"),
    droid: path.join(homeDir, ".factory", "hooks.json"),
    gemini: path.join(homeDir, ".gemini", "settings.json"),
    mastra: path.join(homeDir, ".mastracode", "hooks.json"),
  }
}

export function getClaudeManagedHookCommand() {
  return `[ -n "$CLAXEDO_HOME_DIR" ] && [ -x "$CLAXEDO_HOME_DIR/${CLAUDE_NOTIFY_RELATIVE}" ] && "$CLAXEDO_HOME_DIR/${CLAUDE_NOTIFY_RELATIVE}" --harness=claude || true`
}

/** The notify command a foreign hook config runs, labelled with the harness that owns the config. */
function notifyCommand(notifyPath: string, harness: string) {
  return `${shellQuote(notifyPath)} --harness=${harness}`
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
  const filtered = hooks.filter((hook) => !isManaged(str(asRecordOrEmpty(hook).command)))
  if (filtered.length === hooks.length) return definition
  if (filtered.length === 0) return null
  return { ...definition, hooks: filtered }
}

function reconcileNestedHooks(hooks: Record<string, unknown>, input: {
  events: { event: string; definition: Record<string, unknown> }[]
  isManaged: (command: string | undefined) => boolean
}) {
  // Remove this owner's previous registrations, including retired events.
  // User commands in the same definitions remain intact.
  for (const [event, current] of Object.entries(hooks)) {
    if (!Array.isArray(current)) continue
    const retained = current.flatMap((def) => {
      const cleaned = removeManagedHooksFromDefinition(asRecordOrEmpty(def), input.isManaged)
      return cleaned ? [cleaned] : []
    })
    if (retained.length === 0) delete hooks[event]
    else hooks[event] = retained
  }

  for (const item of input.events) {
    const current = hooks[item.event]
    if (Array.isArray(current)) {
      hooks[item.event] = [...current, item.definition]
      continue
    }
    hooks[item.event] = [item.definition]
  }
}

async function upsertNestedHookSettings(input: {
  file: string
  notifyPath: string
  force: boolean
  events: { event: string; definition: Record<string, unknown> }[]
  isManaged: (command: string | undefined) => boolean
}) {
  const existing = asRecordOrEmpty(await readJson(input.file))
  const hooks = recordAt(existing, "hooks")

  reconcileNestedHooks(hooks, input)

  await writeIfChanged(input.file, JSON.stringify(existing, null, 2) + "\n", 0o644, input.force)
}

async function materializeClaude(input: { file: string; notifyPath: string; force: boolean }) {
  const command = getClaudeManagedHookCommand()
  await upsertNestedHookSettings({
    ...input,
    events: [
      { event: "UserPromptSubmit", definition: { hooks: [{ type: "command", command }] } },
      { event: "Stop", definition: { hooks: [{ type: "command", command }] } },
      { event: "PostToolUse", definition: { matcher: "*", hooks: [{ type: "command", command }] } },
      { event: "PostToolUseFailure", definition: { matcher: "*", hooks: [{ type: "command", command }] } },
      { event: "PermissionRequest", definition: { matcher: "*", hooks: [{ type: "command", command }] } },
      { event: "PermissionDenied", definition: { matcher: "*", hooks: [{ type: "command", command }] } },
    ],
    isManaged: (command) => isManagedClaudeHookCommand(command, input.notifyPath),
  })
}

async function materializeDroid(input: { file: string; notifyPath: string; force: boolean }) {
  const settingsFile = path.join(path.dirname(input.file), "settings.json")
  const settings = asRecordOrEmpty(await readJson(settingsFile))
  const originalSettings = JSON.stringify(settings)
  const settingsHooks = asRecordOrEmpty(settings.hooks)
  const standalone = await readFileIfExists(input.file)
  // Creating hooks.json changes Droid's precedence. Carry forward user hooks
  // only when settings.json was the effective source, not when it was dormant.
  const hooks = standalone === undefined
    ? structuredClone(settingsHooks)
    : asRecordOrEmpty(await readJson(input.file))
  const isManaged = (command: string | undefined) =>
    !!command && (command.includes(input.notifyPath) || isManagedHookCommand(command, NOTIFY_SCRIPT))
  const command = notifyCommand(input.notifyPath, "droid")
  reconcileNestedHooks(hooks, {
    events: [
      { event: "UserPromptSubmit", definition: { hooks: [{ type: "command", command }] } },
      { event: "Notification", definition: { hooks: [{ type: "command", command }] } },
      { event: "Stop", definition: { hooks: [{ type: "command", command }] } },
      { event: "PostToolUse", definition: { matcher: "*", hooks: [{ type: "command", command }] } },
    ],
    isManaged,
  })
  // Publish the canonical file before retiring the old registrations. Retrying
  // after a failed cleanup is safe because reconciliation is idempotent.
  await writeIfChanged(input.file, JSON.stringify(hooks, null, 2) + "\n", 0o644, input.force)
  reconcileNestedHooks(settingsHooks, { events: [], isManaged })
  if (JSON.stringify(settings) !== originalSettings) {
    if (Object.keys(settingsHooks).length === 0) delete settings.hooks
    await writeIfChanged(settingsFile, JSON.stringify(settings, null, 2) + "\n", 0o644, input.force)
  }
}

function pruneCodexHooks(hooks: Record<string, unknown>, notifyPath: string) {
  for (const [name, current] of Object.entries(hooks)) {
    if (!Array.isArray(current)) continue
    const entries = current.flatMap((def) => {
      const next = removeManagedHooksFromDefinition(asRecordOrEmpty(def), (cmd) =>
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
  const existing = asRecordOrEmpty(await readJson(input.file))
  if (!existing.hooks && !input.native) return
  const hooks = recordAt(existing, "hooks")
  pruneCodexHooks(hooks, input.notifyPath)

  if (input.native) {
    const command = notifyCommand(input.notifyPath, "codex")
    const events = [
      { event: "SessionStart", definition: { hooks: [{ type: "command", command }] } },
      { event: "UserPromptSubmit", definition: { hooks: [{ type: "command", command }] } },
      { event: "Stop", definition: { hooks: [{ type: "command", command }] } },
      { event: "Interrupt", definition: { hooks: [{ type: "command", command }] } },
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
  const root = asRecordOrEmpty(await readJson(input.file))
  const hooks = recordAt(root, "hooks")

  for (const event of ["BeforeAgent", "AfterAgent", "AfterTool"]) {
    hooks[event] = reconcileManagedEntries({
      current: arr(hooks[event]),
      desired: [{ hooks: [{ type: "command", command: input.hookPath }] }],
      isManaged: (entry) => {
        const nested = arr(asRecordOrEmpty(entry).hooks) ?? []
        return nested.some((hook) => {
          const command = str(asRecordOrEmpty(hook).command)
          return command === input.hookPath || isManagedHookCommand(command, GEMINI_HOOK_SCRIPT)
        })
      },
      isEquivalent: (a, b) => JSON.stringify(asRecordOrEmpty(a).hooks ?? []) === JSON.stringify(asRecordOrEmpty(b).hooks ?? []),
    })
  }

  await writeIfChanged(input.file, JSON.stringify(root, null, 2) + "\n", 0o644, input.force)
}

async function materializeCursor(input: { file: string; hookPath: string; force: boolean }) {
  const root = asRecordOrEmpty(await readJson(input.file))
  if (typeof root.version !== "number") root.version = 1
  const hooks = recordAt(root, "hooks")
  // Cursor has no hook for "waiting on approval": the before-hooks fire for
  // every shell/MCP call and the runtime holds the terminal on that ask until
  // the same call completes or fails. Cursor applies the matcher itself, so
  // file-tool completions never spawn the hook.
  const toolMatcher = "^(Shell|MCP:.+)$"
  const desired: Record<string, { command: string; matcher?: string }> = {
    beforeSubmitPrompt: { command: `${input.hookPath} Start` },
    stop: { command: `${input.hookPath} Stop` },
    beforeShellExecution: { command: `${input.hookPath} PermissionRequest` },
    beforeMCPExecution: { command: `${input.hookPath} PermissionRequest` },
    postToolUse: { command: `${input.hookPath} PostToolUse`, matcher: toolMatcher },
    postToolUseFailure: { command: `${input.hookPath} PostToolUse`, matcher: toolMatcher },
  }

  for (const [event, entry] of Object.entries(desired)) {
    hooks[event] = reconcileManagedEntries({
      current: arr(hooks[event]),
      desired: [entry],
      isManaged: (item) => {
        const command = str(asRecordOrEmpty(item).command)
        return command?.includes(input.hookPath) || isManagedHookCommand(command, CURSOR_HOOK_SCRIPT)
      },
      isEquivalent: (a, b) => asRecordOrEmpty(a).command === asRecordOrEmpty(b).command,
    })
  }

  await writeIfChanged(input.file, JSON.stringify(root, null, 2) + "\n", 0o644, input.force)
}

async function materializeMastra(input: { file: string; notifyPath: string; force: boolean }) {
  const root = asRecordOrEmpty(await readJson(input.file))
  const command = `bash ${notifyCommand(input.notifyPath, "mastracode")}`

  for (const event of ["UserPromptSubmit", "Stop", "PostToolUse"]) {
    root[event] = reconcileManagedEntries({
      current: arr(root[event]),
      desired: [{ type: "command", command }],
      isManaged: (entry) => {
        const current = str(asRecordOrEmpty(entry).command)
        return current?.includes(input.notifyPath) || isManagedHookCommand(current, NOTIFY_SCRIPT)
      },
      isEquivalent: (a, b) => asRecordOrEmpty(a).command === asRecordOrEmpty(b).command,
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
      runner: "antigravity",
      file: files.antigravity,
      run: async () => {
        const root = asRecordOrEmpty(await readJson(files.antigravity))
        const hookPath = path.join(path.dirname(input.notifyPath), "antigravity-hook.sh")
        const desired = Object.fromEntries(["PreInvocation", "Stop"].map((event) => [event, [
          { type: "command", command: `bash ${shellQuote(hookPath)} ${event}`, timeout: 3 },
        ]]))
        const current = rec(root["claxedo-lifecycle"])
        if (root["claxedo-lifecycle"] !== undefined && (!current || !Object.values(current).every((handlers) =>
          arr(handlers)?.every((handler) => isManagedHookCommand(str(rec(handler)?.command), "antigravity-hook.sh"))))) {
          throw new Error("Refusing to overwrite an unrecognized Antigravity hook named claxedo-lifecycle")
        }
        await writeIfChanged(hookPath, generateAntigravityHook(input.notifyPath), 0o755, force)
        root["claxedo-lifecycle"] = desired
        await writeIfChanged(files.antigravity, JSON.stringify(root, null, 2) + "\n", 0o644, force)
      },
    }),
    applyHook({
      runner: "amp",
      file: files.amp,
      run: async () => {
        const existing = await readFileIfExists(files.amp)
        if (existing !== undefined && !existing.startsWith("// Claxedo Amp lifecycle plugin v1\n")) {
          throw new Error("Refusing to overwrite an unrecognized Amp plugin at " + files.amp)
        }
        await writeIfChanged(files.amp, generateAmpPlugin(), 0o644, force)
      },
    }),
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
