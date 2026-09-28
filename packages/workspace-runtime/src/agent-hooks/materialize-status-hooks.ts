import fs from "fs/promises"
import path from "path"
import { isDeepStrictEqual } from "util"
import { ConfigChangedError, ConfigEdits, readConfig, reconcileFlatEntries, reconcileNestedEntries, writeMergedConfig, type IsManagedCommand } from "./config-merge"
import { writeIfChanged as writeFileAtomically } from "./core/utils"
import { arr, rec, str } from "../json-value"
import { generateAmpPlugin, generateAntigravityHook } from "./core/hooks"
import { ANTIGRAVITY_HOOK, CURSOR_HOOK, GEMINI_HOOK, NOTIFY_MARKER, NOTIFY_SCRIPT } from "./core/constants"
import { isMissingFile } from "@claxedo/helpers/fs"

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
}

export type AgentHookRunner = "cursor" | "droid" | "gemini" | "mastra" | "amp" | "antigravity"

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
}

// `[bash] <script> [--harness=<name> | <Event>]`, the script shell-quoted or bare.
const GENERATED_HOOK_COMMAND = /^(?:bash\s+)?(?:'((?:[^']|'\\'')+)'|([^\s'"]+))(?:\s+(?:--harness=[\w-]+|[A-Za-z]+))?$/

function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'"
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

function generatedScriptPath(command: string, scriptName: string) {
  const match = GENERATED_HOOK_COMMAND.exec(command.trim())
  const script = match?.[1]?.replaceAll("'\\''", "'") ?? match?.[2]
  if (!script || !path.isAbsolute(script)) return undefined
  return script.replaceAll("\\", "/").endsWith(`/hooks/${scriptName}`) ? script : undefined
}

async function isGeneratedScript(file: string) {
  try {
    return (await fs.readFile(file, "utf8")).includes(NOTIFY_MARKER)
  } catch (error) {
    const code = str(rec(error)?.code)
    return code === "ENOENT" || code === "ENOTDIR"
  }
}

function hookCommands(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(hookCommands)
  const record = rec(value)
  if (!record) return []
  return [...(typeof record.command === "string" ? [record.command] : []), ...Object.values(record).flatMap(hookCommands)]
}

/**
 * Which hook commands in `configs` are registrations this runtime wrote: a
 * generated-shape invocation of `scriptName` from a `hooks/` directory whose
 * script carries NOTIFY_MARKER or no longer exists. Neither the current path
 * nor a directory name can say this, because the data root moves between
 * installs and every test run gets its own temp root. A foreign registration
 * of the same bare shape whose script was deleted is also treated as managed.
 */
async function loadManagedHookCommands(scriptName: string, ...configs: unknown[]): Promise<IsManagedCommand> {
  const scripts = new Map<string, string>()
  for (const command of configs.flatMap(hookCommands)) {
    const script = generatedScriptPath(command, scriptName)
    if (script) scripts.set(command, script)
  }
  const owned = new Set<string>()
  await Promise.all([...new Set(scripts.values())].map(async (script) => {
    if (await isGeneratedScript(script)) owned.add(script)
  }))
  return (command) => {
    const script = command === undefined ? undefined : scripts.get(command)
    return script !== undefined && owned.has(script)
  }
}

export function agentHookConfigPaths(homeDir: string) {
  return {
    antigravity: path.join(homeDir, ".gemini", "config", "hooks.json"),
    amp: path.join(homeDir, ".config", "amp", "plugins", "claxedo-lifecycle.ts"),
    cursor: path.join(homeDir, ".cursor", "hooks.json"),
    droid: path.join(homeDir, ".factory", "settings.json"),
    gemini: path.join(homeDir, ".gemini", "settings.json"),
    mastra: path.join(homeDir, ".mastracode", "hooks.json"),
  }
}

/** The notify command a foreign hook config runs, labelled with the harness that owns the config. */
function notifyCommand(notifyPath: string, harness: string) {
  return `${shellQuote(notifyPath)} --harness=${harness}`
}

async function materializeDroid(input: { file: string; notifyPath: string }) {
  const settingsFile = input.file
  const standaloneFile = path.join(path.dirname(input.file), "hooks.json")
  const standalone = await readConfig(standaloneFile)
  const settings = await readConfig(settingsFile)
  const settingsHooks = rec(settings.value.hooks)
  if (settings.value.hooks !== undefined && !settingsHooks) throw new Error(`Droid settings ${settingsFile} has a non-object hooks field; refusing to rewrite it`)
  const isManaged = await loadManagedHookCommands(NOTIFY_SCRIPT, standalone.value, settingsHooks ?? {})
  const command = { type: "command", command: notifyCommand(input.notifyPath, "droid") }
  const desired = {
    UserPromptSubmit: { hooks: [command] },
    Notification: { hooks: [command] },
    Stop: { hooks: [command] },
    PostToolUse: { matcher: "*", hooks: [command] },
  }
  // Droid reads hooks.json in place of settings.json's hooks once it exists,
  // so Claxedo registers in whichever file is in effect and never creates one.
  const effective = standalone.original !== undefined
  const target = new ConfigEdits(effective ? standalone.original : settings.original)
  reconcileNestedEntries(target, effective ? [] : ["hooks"], effective ? standalone.value : settingsHooks, desired, isManaged)
  await writeMergedConfig(effective ? standaloneFile : settingsFile, effective ? standalone.original : settings.original, target.result())
  if (!effective || !settingsHooks) return
  const retired = new ConfigEdits(settings.original)
  reconcileNestedEntries(retired, ["hooks"], settingsHooks, {}, isManaged)
  await writeMergedConfig(settingsFile, settings.original, retired.result())
}

async function materializeGemini(input: { file: string; hookPath: string }) {
  const { original, value } = await readConfig(input.file)
  const hooks = rec(value.hooks)
  if (value.hooks !== undefined && !hooks) throw new Error(`Gemini settings ${input.file} has a non-object hooks field; refusing to rewrite it`)
  const isGenerated = await loadManagedHookCommands(GEMINI_HOOK, hooks ?? {})
  const definition = { hooks: [{ type: "command", command: input.hookPath }] }
  const edits = new ConfigEdits(original)
  reconcileNestedEntries(edits, ["hooks"], hooks, { BeforeAgent: definition, AfterAgent: definition, AfterTool: definition },
    (command) => command === input.hookPath || isGenerated(command))
  await writeMergedConfig(input.file, original, edits.result())
}

const CURSOR_TOOL_MATCHER = "^(Shell|MCP:.+)$"

function cursorEntries(hookPath: string): Record<string, Record<string, unknown>> {
  // Cursor has no hook for "waiting on approval": the before-hooks fire for
  // every shell/MCP call and the runtime holds the terminal on that ask until
  // the same call completes or fails. Cursor applies the matcher itself, so
  // file-tool completions never spawn the hook.
  return {
    beforeSubmitPrompt: { command: `${hookPath} Start` },
    stop: { command: `${hookPath} Stop` },
    beforeShellExecution: { command: `${hookPath} PermissionRequest` },
    beforeMCPExecution: { command: `${hookPath} PermissionRequest` },
    postToolUse: { command: `${hookPath} PostToolUse`, matcher: CURSOR_TOOL_MATCHER },
    postToolUseFailure: { command: `${hookPath} PostToolUse`, matcher: CURSOR_TOOL_MATCHER },
  }
}

// ~/.cursor/hooks.json is the person's file, and the one place cursor-agent
// reads user hooks from. Only Claxedo's own entries are ever added or removed;
// every other byte of the file is kept, so the person's entries keep their
// order and formatting.
async function materializeCursor(input: { file: string; hookPath: string }) {
  const { original, value } = await readConfig(input.file)
  const hooks = rec(value.hooks)
  if (value.hooks !== undefined && !hooks) throw new Error(`Cursor hooks file ${input.file} has a non-object hooks field; refusing to rewrite it`)
  const isGenerated = await loadManagedHookCommands(CURSOR_HOOK, hooks ?? {})
  const edits = new ConfigEdits(original)
  if (typeof value.version !== "number") edits.set(["version"], 1)
  reconcileFlatEntries(edits, ["hooks"], hooks, cursorEntries(input.hookPath),
    (command) => !!command?.startsWith(`${input.hookPath} `) || isGenerated(command))
  await writeMergedConfig(input.file, original, edits.result())
}

async function materializeMastra(input: { file: string; notifyPath: string }) {
  const { original, value } = await readConfig(input.file)
  const entry = { type: "command", command: `bash ${notifyCommand(input.notifyPath, "mastracode")}` }
  const edits = new ConfigEdits(original)
  reconcileFlatEntries(edits, [], value, { UserPromptSubmit: entry, Stop: entry, PostToolUse: entry },
    await loadManagedHookCommands(NOTIFY_SCRIPT, value))
  await writeMergedConfig(input.file, original, edits.result())
}

async function applyHook(input: {
  runner: AgentHookRunner
  file: string
  run: () => Promise<void>
}): Promise<AgentHookMaterializationResult> {
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await input.run()
        break
      } catch (error) {
        if (!(error instanceof ConfigChangedError) || attempt === 3) throw error
      }
    }
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
  const files = agentHookConfigPaths(input.homeDir)
  const force = input.force ?? false
  return Promise.all([
    applyHook({
      runner: "antigravity",
      file: files.antigravity,
      run: async () => {
        const { original, value: root } = await readConfig(files.antigravity)
        const hookPath = path.join(path.dirname(input.notifyPath), ANTIGRAVITY_HOOK)
        const desired = Object.fromEntries(["PreInvocation", "Stop"].map((event) => [event, [
          { type: "command", command: `bash ${shellQuote(hookPath)} ${event}`, timeout: 3 },
        ]]))
        const current = rec(root["claxedo-lifecycle"])
        const isManaged = await loadManagedHookCommands(ANTIGRAVITY_HOOK, current)
        if (root["claxedo-lifecycle"] !== undefined && (!current || !Object.values(current).every((handlers) =>
          arr(handlers)?.every((handler) => isManaged(str(rec(handler)?.command)))))) {
          throw new Error("Refusing to overwrite an unrecognized Antigravity hook named claxedo-lifecycle")
        }
        await writeIfChanged(hookPath, generateAntigravityHook(input.notifyPath), 0o755, force)
        if (isDeepStrictEqual(current, desired)) return
        const edits = new ConfigEdits(original)
        edits.set(["claxedo-lifecycle"], desired)
        await writeMergedConfig(files.antigravity, original, edits.result())
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
        await writeMergedConfig(files.amp, existing, generateAmpPlugin())
      },
    }),
    applyHook({
      runner: "droid",
      file: files.droid,
      run: () => materializeDroid({ file: files.droid, notifyPath: input.notifyPath }),
    }),
    applyHook({
      runner: "gemini",
      file: files.gemini,
      run: () => materializeGemini({ file: files.gemini, hookPath: input.geminiHookPath }),
    }),
    applyHook({
      runner: "cursor",
      file: files.cursor,
      run: () => materializeCursor({ file: files.cursor, hookPath: input.cursorHookPath }),
    }),
    applyHook({
      runner: "mastra",
      file: files.mastra,
      run: () => materializeMastra({ file: files.mastra, notifyPath: input.notifyPath }),
    }),
  ])
}
