import fs from "fs/promises"
import path from "path"
import { isDeepStrictEqual } from "util"
import {
  ConfigChangedError,
  ConfigEdits,
  readConfig,
  reconcileFlatEntries,
  reconcileNestedEntries,
  writeMergedConfig,
  type IsManagedCommand,
} from "./config-merge"
import { arr, rec, str } from "@claxedo/session-core"
import type { StatusHookTemplate } from "@claxedo/plugin-api"
import { hookVariables, renderHookText, renderHookValue } from "./core/render"
import { NOTIFY_MARKER } from "./core/constants"
import { isMissingFile } from "@claxedo/helpers/fs"

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
}

export type AgentHookMaterializationResult = {
  runner: string
  component: "hooks"
  type: "hook"
  status: "applied" | "failed" | "skipped"
  path?: string
  reason?: string
}

export type MaterializeAgentHooksOptions = {
  homeDir: string
  notifyPath: string
  templates: readonly StatusHookTemplate[]
}

// `[bash] <script> [--harness=<name> | <Event>]`, the script shell-quoted or bare.
const GENERATED_HOOK_COMMAND = /^(?:bash\s+)?(?:'((?:[^']|'\\'')+)'|([^\s'"]+))(?:\s+(?:--harness=[\w-]+|[A-Za-z]+))?$/

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
  return [
    ...(typeof record.command === "string" ? [record.command] : []),
    ...Object.values(record).flatMap(hookCommands),
  ]
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
  await Promise.all(
    [...new Set(scripts.values())].map(async (script) => {
      if (await isGeneratedScript(script)) owned.add(script)
    }),
  )
  return (command) => {
    const script = command === undefined ? undefined : scripts.get(command)
    return script !== undefined && owned.has(script)
  }
}

export function agentHookConfigPaths(homeDir: string, templates: readonly StatusHookTemplate[]) {
  return Object.fromEntries(
    templates.flatMap((template) =>
      template.install.type === "config-merge"
        ? [[template.command, path.join(homeDir, template.install.path.slice(2))]]
        : [],
    ),
  )
}

function valueAt(value: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  let current: unknown = value
  for (const key of keys) current = rec(current)?.[key]
  if (current !== undefined && !rec(current))
    throw new Error("Hook config has a non-object container; refusing to rewrite it")
  return rec(current)
}

async function mergeTemplate(template: StatusHookTemplate, input: MaterializeAgentHooksOptions) {
  const install = template.install
  if (install.type !== "config-merge") return
  const file = path.join(input.homeDir, install.path.slice(2))
  if (install.shape === "text") {
    const original = await readFileIfExists(file)
    if (original !== undefined && !original.startsWith(install.ownedPrefix!))
      throw new Error(`Refusing to overwrite an unrecognized plugin at ${file}`)
    await writeMergedConfig(
      file,
      original,
      renderHookText(install.entries as string, hookVariables(template, input.notifyPath)),
    )
    return
  }
  const primary = await readConfig(file)
  const base = install.base ?? []
  const current = valueAt(primary.value, base)
  const effective = install.effectiveFile
  const alternateFile = effective && path.join(input.homeDir, effective.path.slice(2))
  const alternate = alternateFile ? await readConfig(alternateFile) : undefined
  const selected = alternate?.original !== undefined ? alternate : primary
  const target = selected === alternate ? alternateFile! : file
  const targetBase = selected === alternate ? effective!.base : base
  const container = valueAt(selected.value, targetBase)
  const entries = renderHookValue(install.entries, hookVariables(template, input.notifyPath)) as Record<
    string,
    Record<string, unknown>
  >
  const isManaged = await loadManagedHookCommands(install.managedScript!, primary.value, alternate?.value)
  const desiredCommands = new Set(hookCommands(entries))
  const owns = (command: string | undefined) =>
    command !== undefined && (desiredCommands.has(command) || isManaged(command))
  const edits = new ConfigEdits(selected.original)
  for (const [key, value] of Object.entries(install.defaults ?? {})) {
    if (typeof selected.value[key] !== typeof value) edits.set([key], value)
  }
  if (install.shape === "named") {
    if (
      container &&
      !Object.values(container).every((handlers) =>
        arr(handlers)?.every((handler) => isManaged(str(rec(handler)?.command))),
      )
    ) {
      throw new Error(`Refusing to overwrite an unrecognized hook named ${targetBase.join(".")}`)
    }
    const desired = Object.fromEntries(Object.entries(entries).map(([event, entry]) => [event, [entry]]))
    if (!isDeepStrictEqual(container, desired)) edits.set(targetBase, desired)
  } else {
    const reconcile = install.shape === "nested" ? reconcileNestedEntries : reconcileFlatEntries
    reconcile(edits, targetBase, container, entries, owns)
  }
  await writeMergedConfig(target, selected.original, edits.result())
  if (selected !== alternate || !current) return
  const retired = new ConfigEdits(primary.original)
  const reconcile = install.shape === "nested" ? reconcileNestedEntries : reconcileFlatEntries
  reconcile(retired, base, current, {}, isManaged)
  await writeMergedConfig(file, primary.original, retired.result())
}

export async function materializeAgentHooks(
  input: MaterializeAgentHooksOptions,
): Promise<AgentHookMaterializationResult[]> {
  const results: AgentHookMaterializationResult[] = []
  for (const template of input.templates) {
    if (template.install.type !== "config-merge") continue
    const file = path.join(input.homeDir, template.install.path.slice(2))
    const result = {
      runner: template.command,
      component: "hooks" as const,
      type: "hook" as const,
      path: file,
    }
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          await mergeTemplate(template, input)
          break
        } catch (error) {
          if (!(error instanceof ConfigChangedError) || attempt === 3) throw error
        }
      }
      results.push({ ...result, status: "applied" })
    } catch (error) {
      results.push({ ...result, status: "failed", reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}
