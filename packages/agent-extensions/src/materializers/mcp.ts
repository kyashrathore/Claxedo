import fs from "fs/promises"
import path from "path"
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser"
import type { MaterializedAgentExtensionScope, HarnessTarget } from "../types"
import { readFileIfExists, writeFileAtomic } from "../fs-safe"
import { AgentExtensionMaterializationError, type MaterializedRuntimeRecord } from "../materialization"

export type StdioMcpServerConfig = {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export type RemoteMcpServerConfig = {
  url: string
  headers?: Record<string, string>
}

export type StandaloneMcpServerConfig = StdioMcpServerConfig | RemoteMcpServerConfig

export type StandaloneMcpConfig = {
  servers: Record<string, StandaloneMcpServerConfig>
}

function asRecord(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {}
}

function sortedObject<T>(input: Record<string, T>) {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))) as Record<string, T>
}

export function normalizeStandaloneMcpConfig(input: Record<string, unknown>): StandaloneMcpConfig {
  const root = asRecord(input.mcpServers ?? input.servers)
  const servers = Object.fromEntries(Object.entries(root).map(([name, value]) => {
    const cfg = asRecord(value)
    if (typeof cfg.command === "string") {
      return [name, {
        command: cfg.command,
        ...(Array.isArray(cfg.args) ? { args: cfg.args.filter((item): item is string => typeof item === "string") } : {}),
        ...(Object.keys(asRecord(cfg.env)).length > 0 ? { env: asRecord(cfg.env) as Record<string, string> } : {}),
      }]
    }
    if (typeof cfg.url === "string") {
      return [name, {
        url: cfg.url,
        ...(Object.keys(asRecord(cfg.headers)).length > 0 ? { headers: asRecord(cfg.headers) as Record<string, string> } : {}),
      }]
    }
    throw new AgentExtensionMaterializationError(`MCP server ${name} must include command or url`)
  }))
  if (Object.keys(servers).length === 0) throw new AgentExtensionMaterializationError("Standalone MCP config must declare at least one server")
  return { servers: sortedObject(servers) }
}

export function mcpTargetPath(input: {
  runner: HarnessTarget
  scope: MaterializedAgentExtensionScope
  projectDir?: string
  homeDir?: string
}) {
  if (input.runner === "cursor") {
    if (input.scope === "project") {
      if (!input.projectDir) throw new Error("projectDir is required for project Cursor MCP materialization")
      return path.join(input.projectDir, ".cursor", "mcp.json")
    }
    if (!input.homeDir) throw new Error("homeDir is required for machine Cursor MCP materialization")
    return path.join(input.homeDir, ".cursor", "mcp.json")
  }
  if (input.runner === "claude") {
    if (input.scope === "project") {
      if (!input.projectDir) throw new Error("projectDir is required for project Claude MCP materialization")
      return path.join(input.projectDir, ".mcp.json")
    }
    if (!input.homeDir) throw new Error("homeDir is required for machine Claude MCP materialization")
    return path.join(input.homeDir, ".claude.json")
  }
  if (input.runner === "codex") {
    if (input.scope === "project") {
      if (!input.projectDir) throw new Error("projectDir is required for project Codex MCP materialization")
      return path.join(input.projectDir, ".codex", "config.toml")
    }
    if (!input.homeDir) throw new Error("homeDir is required for machine Codex MCP materialization")
    return path.join(input.homeDir, ".codex", "config.toml")
  }
  if (input.runner === "opencode") {
    if (input.scope === "project") {
      if (!input.projectDir) throw new Error("projectDir is required for project OpenCode MCP materialization")
      return path.join(input.projectDir, ".opencode", "opencode.jsonc")
    }
    if (!input.homeDir) throw new Error("homeDir is required for machine OpenCode MCP materialization")
    return path.join(input.homeDir, ".config", "opencode", "opencode.jsonc")
  }
  return undefined
}

function componentOwned(input: {
  record?: MaterializedRuntimeRecord
  ownerId: string
  path: string
  component: string
}) {
  return input.record?.packages[input.ownerId]?.components.some((item) =>
    item.path === input.path && item.component === input.component && item.status === "applied"
  ) ?? false
}

function mcpComponents(input: {
  runner: HarnessTarget
  target: string
  names: string[]
  drifted?: Set<string>
  existing?: Set<string>
}) {
  return input.names.map((name) => ({
    runner: input.runner,
    component: name,
    type: "mcp" as const,
    status: input.drifted?.has(name)
      ? "drifted" as const
      : input.existing && !input.existing.has(name)
        ? "skipped" as const
        : "applied" as const,
    ...(input.drifted?.has(name) ? { reason: "owned MCP config differs from desired source" } : {}),
    ...(input.existing && !input.existing.has(name) ? { reason: "not applied because another owned MCP config drifted" } : {}),
    path: input.target,
  }))
}

function toRunnerMcpServers(runner: HarnessTarget, config: StandaloneMcpConfig) {
  return sortedObject(Object.fromEntries(Object.entries(config.servers).map(([name, cfg]) => {
    if ("url" in cfg) return [name, cfg]
    if (runner === "claude") return [name, {
      type: "stdio",
      command: cfg.command,
      args: cfg.args ?? [],
      env: cfg.env ?? {},
    }]
    return [name, {
      command: cfg.command,
      args: cfg.args ?? [],
      env: cfg.env ?? {},
    }]
  })))
}

function toOpenCodeMcpServers(config: StandaloneMcpConfig) {
  return sortedObject(Object.fromEntries(Object.entries(config.servers).map(([name, cfg]) => {
    if ("url" in cfg) return [name, {
      type: "remote",
      url: cfg.url,
      enabled: true,
      ...(cfg.headers && Object.keys(cfg.headers).length > 0 ? { headers: cfg.headers } : {}),
    }]
    return [name, {
      type: "local",
      command: [cfg.command, ...(cfg.args ?? [])],
      enabled: true,
      ...(cfg.env && Object.keys(cfg.env).length > 0 ? { environment: cfg.env } : {}),
    }]
  })))
}

function tomlString(input: string) {
  return `"${input.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function tomlKey(input: string) {
  return /^[A-Za-z0-9_-]+$/.test(input) ? input : tomlString(input)
}

function tomlArray(input: string[]) {
  return `[${input.map(tomlString).join(", ")}]`
}

function tomlInlineTable(input: Record<string, string>) {
  return `{ ${Object.entries(sortedObject(input)).map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`).join(", ")} }`
}

function codexMcpSection(name: string, config: StandaloneMcpServerConfig) {
  const lines = [`[mcp_servers.${tomlKey(name)}]`]
  if ("url" in config) {
    lines.push(`url = ${tomlString(config.url)}`)
    if (config.headers && Object.keys(config.headers).length > 0) lines.push(`headers = ${tomlInlineTable(config.headers)}`)
    return `${lines.join("\n")}\n`
  }
  lines.push(`command = ${tomlString(config.command)}`)
  if (config.args) lines.push(`args = ${tomlArray(config.args)}`)
  if (config.env && Object.keys(config.env).length > 0) lines.push(`env = ${tomlInlineTable(config.env)}`)
  return `${lines.join("\n")}\n`
}

function unquoteTomlKey(input: string) {
  return input.startsWith('"') && input.endsWith('"') ? input.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\") : input
}

function codexMcpSections(raw: string) {
  const lines = raw.split(/(?<=\n)/)
  const sections: Array<{ name: string; start: number; end: number; body: string }> = []
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(/^\s*\[mcp_servers\.((?:"(?:\\.|[^"])+")|[A-Za-z0-9_-]+)\]\s*$/)
    const start = offset
    offset += lines[i]!.length
    if (!match) continue
    let end = offset
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*\[.+\]\s*$/.test(lines[j]!)) break
      end += lines[j]!.length
    }
    sections.push({ name: unquoteTomlKey(match[1]!), start, end, body: raw.slice(start, end) })
  }
  return sections
}

async function readText(file: string) {
  return await readFileIfExists(file) ?? ""
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  const raw = await readFileIfExists(file)
  if (raw === undefined || !raw.trim()) return {}
  return readJsonFromText(raw, file)
}

// Target config files (.mcp.json, ~/.claude.json, opencode.jsonc, ...) are
// user-owned. A parse failure must abort instead of reading as "empty":
// an empty read would rewrite the file with only this extension's servers,
// or delete it outright on uninstall.
function readJsonFromText(raw: string, file: string): Record<string, unknown> {
  const errors: ParseError[] = []
  const parsed = parseJsonc(raw, errors)
  if (errors.length > 0) {
    throw new AgentExtensionMaterializationError(
      `MCP target config ${file} contains invalid JSON; fix it before materializing (refusing to rewrite a file that cannot be parsed)`,
      "agent_extension_materialization_error",
      { targetPath: file },
    )
  }
  return asRecord(parsed)
}

async function writeJson(file: string, input: Record<string, unknown>) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 })
  await writeFileAtomic(file, JSON.stringify(input, null, 2) + "\n")
}

const JSONC_FORMAT = { formattingOptions: { tabSize: 2, insertSpaces: true } }

export async function removeStandaloneMcpEntries(input: {
  file: string
  names: string[]
}) {
  if (input.file.endsWith(".toml")) {
    const raw = await readText(input.file)
    // Nothing to remove from a missing or empty file; writing here would
    // recreate a config file the user deleted.
    if (!raw) return
    const names = new Set(input.names)
    const sections = codexMcpSections(raw).filter((section) => names.has(section.name))
    if (sections.length === 0) return
    const next = [...sections].reverse().reduce((text, section) => `${text.slice(0, section.start)}${text.slice(section.end)}`, raw)
    await writeFileAtomic(input.file, next.replace(/\n{3,}/g, "\n\n"))
    return
  }
  if (input.file.endsWith("opencode.jsonc") || input.file.endsWith("opencode.json")) {
    const raw = await readText(input.file)
    if (!raw.trim()) return
    readJsonFromText(raw, input.file)
    // Remove entries with jsonc edits (mirroring how they were added) so the
    // user's comments and formatting survive instead of being re-serialized.
    let text = raw
    for (const name of input.names) {
      text = applyEdits(text, modify(text, ["mcp", name], undefined, JSONC_FORMAT))
    }
    const withoutEntries = readJsonFromText(text, input.file)
    if (Object.keys(asRecord(withoutEntries.mcp)).length === 0) {
      text = applyEdits(text, modify(text, ["mcp"], undefined, JSONC_FORMAT))
    }
    if (Object.keys(readJsonFromText(text, input.file)).length === 0) {
      await fs.rm(input.file, { force: true })
      return
    }
    await writeFileAtomic(input.file, `${text.trimEnd()}\n`)
    return
  }
  const root = await readJson(input.file)
  const current = asRecord(root.mcpServers)
  for (const name of input.names) {
    delete current[name]
  }
  const next = { ...root }
  if (Object.keys(current).length > 0) next.mcpServers = sortedObject(current)
  else delete next.mcpServers
  if (Object.keys(next).length === 0) {
    await fs.rm(input.file, { force: true })
    return
  }
  await writeJson(input.file, next)
}

export async function materializeStandaloneMcp(input: {
  config: StandaloneMcpConfig
  runner: HarnessTarget
  scope: MaterializedAgentExtensionScope
  ownerId: string
  projectDir?: string
  homeDir?: string
  record?: MaterializedRuntimeRecord
  replaceOwned?: boolean
}) {
  const target = mcpTargetPath(input)
  if (!target) {
    return Object.keys(input.config.servers).map((name) => ({
      runner: input.runner,
      component: name,
      type: "mcp" as const,
      status: "skipped" as const,
      reason: "native MCP config path not verified",
    }))
  }
  if (input.runner === "codex") {
    const raw = await readText(target)
    const sections = codexMcpSections(raw)
    const nextSections = input.config.servers
    const drifted = new Set<string>()
    for (const [name, next] of Object.entries(nextSections)) {
      const current = sections.find((section) => section.name === name)
      if (!current) continue
      if (!componentOwned({ record: input.record, ownerId: input.ownerId, path: target, component: name })) {
        throw new AgentExtensionMaterializationError(
          `MCP server ${name} already exists in ${target}`,
          "agent_extension_mcp_server_conflict",
          {
            ownerId: input.ownerId,
            runner: input.runner,
            serverName: name,
            targetPath: target,
          },
        )
      }
      if (!input.replaceOwned && current.body.trim() !== codexMcpSection(name, next).trim()) {
        drifted.add(name)
      }
    }
    if (drifted.size > 0) {
      return mcpComponents({
        runner: input.runner,
        target,
        names: Object.keys(nextSections),
        drifted,
        existing: new Set(sections.map((section) => section.name)),
      })
    }
    const names = new Set(Object.keys(nextSections))
    const withoutOwned = sections
      .filter((section) => names.has(section.name))
      .reverse()
      .reduce((text, section) => `${text.slice(0, section.start)}${text.slice(section.end)}`, raw)
      .replace(/\n{3,}/g, "\n\n")
    const prefix = withoutOwned.trim() ? `${withoutOwned.trimEnd()}\n\n` : ""
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 })
    await writeFileAtomic(target, `${prefix}${Object.entries(nextSections).map(([name, cfg]) => codexMcpSection(name, cfg)).join("\n")}`)
    return mcpComponents({ runner: input.runner, target, names: Object.keys(nextSections) })
  }

  if (input.runner === "opencode") {
    const raw = await readText(target)
    const root = raw.trim() ? readJsonFromText(raw, target) : {}
    const current = asRecord(root.mcp)
    const nextServers = toOpenCodeMcpServers(input.config)
    const drifted = new Set<string>()
    for (const [name, next] of Object.entries(nextServers)) {
      if (current[name] === undefined) continue
      if (!componentOwned({ record: input.record, ownerId: input.ownerId, path: target, component: name })) {
        throw new AgentExtensionMaterializationError(
          `MCP server ${name} already exists in ${target}`,
          "agent_extension_mcp_server_conflict",
          {
            ownerId: input.ownerId,
            runner: input.runner,
            serverName: name,
            targetPath: target,
          },
        )
      }
      if (!input.replaceOwned && JSON.stringify(current[name]) !== JSON.stringify(next)) {
        drifted.add(name)
      }
    }
    if (drifted.size > 0) {
      return mcpComponents({
        runner: input.runner,
        target,
        names: Object.keys(nextServers),
        drifted,
        existing: new Set(Object.keys(current)),
      })
    }
    const next = Object.entries(nextServers).reduce((text, [name, value]) => applyEdits(text, modify(text, ["mcp", name], value, {
      formattingOptions: { tabSize: 2, insertSpaces: true },
    })), raw.trim() ? raw : "{}")
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 })
    await writeFileAtomic(target, `${next.trimEnd()}\n`)
    return mcpComponents({ runner: input.runner, target, names: Object.keys(nextServers) })
  }

  const root = await readJson(target)
  const current = asRecord(root.mcpServers)
  const nextServers = toRunnerMcpServers(input.runner, input.config)
  const drifted = new Set<string>()
  for (const [name, next] of Object.entries(nextServers)) {
    if (current[name] === undefined) continue
    if (!componentOwned({ record: input.record, ownerId: input.ownerId, path: target, component: name })) {
      throw new AgentExtensionMaterializationError(
        `MCP server ${name} already exists in ${target}`,
        "agent_extension_mcp_server_conflict",
        {
          ownerId: input.ownerId,
          runner: input.runner,
          serverName: name,
          targetPath: target,
        },
      )
    }
    if (!input.replaceOwned && JSON.stringify(current[name]) !== JSON.stringify(next)) {
      drifted.add(name)
    }
  }
  if (drifted.size > 0) {
    return mcpComponents({
      runner: input.runner,
      target,
      names: Object.keys(nextServers),
      drifted,
      existing: new Set(Object.keys(current)),
    })
  }
  await writeJson(target, {
    ...root,
    mcpServers: {
      ...current,
      ...nextServers,
    },
  })

  return mcpComponents({ runner: input.runner, target, names: Object.keys(nextServers) })
}
