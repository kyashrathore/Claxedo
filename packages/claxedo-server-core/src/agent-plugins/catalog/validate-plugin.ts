import { parse as parseYaml } from "yaml"
import type { AgentPluginTree } from "../artifacts/tree"
import { treeChildren, treeEntry, treeText } from "../artifacts/tree"
import {
  AGENT_PLUGIN_MCP_SCHEMA,
  AGENT_PLUGIN_SCHEMA,
  type AgentPluginDiagnostic,
  type AgentPluginHttpServer,
  type AgentPluginManifest,
  type AgentPluginMcpServer,
  type AgentPluginSkill,
  type AgentPluginStdioServer,
  type AgentPluginValidationResult,
} from "./types"

const MANIFEST_FIELDS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
])

const NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function json(tree: AgentPluginTree, relativePath: string): unknown {
  const text = treeText(tree, relativePath)
  if (text === undefined) throw new Error(`${relativePath} is not a file`)
  return JSON.parse(text)
}

function resolvedKind(tree: AgentPluginTree, relative: string): "file" | "directory" | "missing" | "escape" | "invalid" {
  const entry = treeEntry(tree, relative)
  if (entry?.kind === "invalid") return entry.reason === "path-escape" ? "escape" : "invalid"
  return entry?.kind ?? "missing"
}

function validString(value: unknown): value is string {
  return typeof value === "string"
}

function stringRecord(value: unknown): value is Record<string, string> {
  return record(value) && Object.values(value).every(validString)
}

function extensionRecord(value: unknown): value is Record<string, Record<string, unknown>> {
  return record(value) && Object.values(value).every(record)
}

function validateManifest(raw: unknown): { manifest?: AgentPluginManifest; diagnostics: AgentPluginDiagnostic[] } {
  const diagnostics: AgentPluginDiagnostic[] = []
  if (!record(raw)) {
    return { diagnostics: [{ code: "manifest_invalid", path: "plugin.json", message: "plugin.json must contain an object" }] }
  }

  const unknownFields = Object.keys(raw).filter((field) => !MANIFEST_FIELDS.has(field))
  if (unknownFields.length) {
    return {
      diagnostics: unknownFields.map((field) => ({
        code: "manifest_invalid" as const,
        path: `plugin.json#/${field}`,
        message: `plugin.json contains unknown field ${field}`,
      })),
    }
  }

  const fatal = (message: string) => ({
    diagnostics: [...diagnostics, { code: "manifest_invalid" as const, path: "plugin.json", message }],
  })
  if (raw.$schema !== AGENT_PLUGIN_SCHEMA) return fatal(`$schema must be ${AGENT_PLUGIN_SCHEMA}`)
  if (typeof raw.name !== "string" || raw.name.length < 1 || raw.name.length > 64 || !NAME_PATTERN.test(raw.name)) {
    return fatal("name must satisfy the Agent Plugins v1 name constraints")
  }
  for (const field of ["version", "description", "homepage", "repository", "license"] as const) {
    if (raw[field] !== undefined && !validString(raw[field])) return fatal(`${field} must be a string`)
  }
  if (raw.keywords !== undefined && (!Array.isArray(raw.keywords) || !raw.keywords.every(validString))) {
    return fatal("keywords must be an array of strings")
  }
  if (raw.author !== undefined) {
    if (!record(raw.author)) return fatal("author must be an object")
    if (Object.keys(raw.author).some((field) => !["name", "email", "url"].includes(field))) {
      return fatal("author contains an unknown field")
    }
    if (Object.values(raw.author).some((value) => !validString(value))) return fatal("author values must be strings")
  }

  if (raw.extensions !== undefined && !extensionRecord(raw.extensions)) {
    return fatal("extensions must map reverse-domain namespaces to objects")
  }

  const manifest: AgentPluginManifest = {
    $schema: AGENT_PLUGIN_SCHEMA,
    name: raw.name,
    ...(typeof raw.version === "string" ? { version: raw.version } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(record(raw.author) ? { author: raw.author as AgentPluginManifest["author"] } : {}),
    ...(typeof raw.homepage === "string" ? { homepage: raw.homepage } : {}),
    ...(typeof raw.repository === "string" ? { repository: raw.repository } : {}),
    ...(typeof raw.license === "string" ? { license: raw.license } : {}),
    ...(Array.isArray(raw.keywords) ? { keywords: raw.keywords } : {}),
    ...(extensionRecord(raw.extensions) ? { extensions: raw.extensions } : {}),
  }
  return { manifest, diagnostics }
}

function parseSkillFrontmatter(text: string, directoryName: string): { name: string; description: string } | undefined {
  const normalized = text.replace(/\r\n/g, "\n")
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized)
  if (!match) return undefined
  try {
    const fields = parseYaml(match[1]) as unknown
    if (!record(fields)) return undefined
    if (typeof fields.name !== "string"
      || fields.name !== directoryName
      || fields.name.length > 64
      || !/^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(fields.name)) return undefined
    if (typeof fields.description !== "string"
      || fields.description.length < 1
      || fields.description.length > 1024) return undefined
    if (fields.license !== undefined && typeof fields.license !== "string") return undefined
    if (fields.compatibility !== undefined
      && (typeof fields.compatibility !== "string"
        || fields.compatibility.length < 1
        || fields.compatibility.length > 500)) return undefined
    if (fields.metadata !== undefined
      && !stringRecord(fields.metadata)) return undefined
    if (fields["allowed-tools"] !== undefined && typeof fields["allowed-tools"] !== "string") return undefined
    return { name: fields.name, description: fields.description }
  } catch {
    return undefined
  }
}

function loadSkills(tree: AgentPluginTree, diagnostics: AgentPluginDiagnostic[]): AgentPluginSkill[] {
  const skillsKind = resolvedKind(tree, "skills")
  if (skillsKind === "missing") return []
  if (skillsKind !== "directory") {
    diagnostics.push({ code: "skills_invalid", path: "skills", message: "skills must resolve to a directory inside the plugin root" })
    return []
  }

  const skills: AgentPluginSkill[] = []
  const children = treeChildren(tree, "skills")
  for (const child of children) {
    const relative = `skills/${child}/SKILL.md`
    const kind = resolvedKind(tree, relative)
    if (kind === "missing") continue
    if (kind === "escape") {
      diagnostics.push({ code: "skill_path_escape", path: relative, message: "SKILL.md resolves outside the plugin root" })
      continue
    }
    if (kind !== "file") {
      diagnostics.push({ code: "skill_invalid", path: relative, message: "SKILL.md must resolve to a regular file" })
      continue
    }
    let frontmatter: ReturnType<typeof parseSkillFrontmatter>
    try {
      const text = treeText(tree, relative)
      frontmatter = text === undefined ? undefined : parseSkillFrontmatter(text, child)
    } catch {
      frontmatter = undefined
    }
    if (!frontmatter) {
      diagnostics.push({ code: "skill_invalid", path: relative, message: "SKILL.md does not conform to the Agent Skills specification" })
      continue
    }
    skills.push({ name: frontmatter.name, description: frontmatter.description, path: `skills/${child}` })
  }
  return skills
}

function remoteUrl(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    const url = new URL(value)
    if (url.username || url.password || url.hash) return false
    if (url.protocol === "https:") return true
    if (url.protocol !== "http:") return false
    const hostname = url.hostname.replace(/^\[|\]$/g, "")
    if (hostname === "localhost") return true
    if (/^127(?:\.\d{1,3}){3}$/.test(hostname)) {
      return hostname.split(".").every((part) => Number(part) <= 255)
    }
    return hostname === "::1"
  } catch {
    return false
  }
}

function headers(value: unknown): value is Record<string, string> {
  if (!record(value)) return false
  const names = new Set<string>()
  try {
    for (const [name, content] of Object.entries(value)) {
      if (typeof content !== "string") return false
      const canonical = name.toLowerCase()
      if (names.has(canonical)) return false
      names.add(canonical)
      new Headers([[name, content]])
    }
    return true
  } catch {
    return false
  }
}

function noUnknownFields(raw: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(raw).every((field) => allowed.includes(field))
}

function validateStdioServer(tree: AgentPluginTree, name: string, raw: Record<string, unknown>): AgentPluginStdioServer | undefined {
  if (!noUnknownFields(raw, ["type", "command", "args", "env", "cwd"])) return undefined
  if (typeof raw.command !== "string" || raw.command.length === 0) return undefined
  if (/\s/.test(raw.command)) return undefined
  if (raw.args !== undefined && (!Array.isArray(raw.args) || !raw.args.every(validString))) return undefined
  if (raw.env !== undefined && !stringRecord(raw.env)) return undefined
  if (stringRecord(raw.env) && ("PLUGIN_ROOT" in raw.env || "PLUGIN_DATA" in raw.env)) return undefined
  if (raw.command.startsWith("./") && resolvedKind(tree, raw.command) !== "file") return undefined
  if (raw.command.includes("/") && !raw.command.startsWith("./")) return undefined
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== "string") return undefined
    if (raw.cwd.startsWith("./")) {
      if (resolvedKind(tree, raw.cwd) !== "directory") return undefined
    } else if (raw.cwd === "${PLUGIN_ROOT}" || raw.cwd.startsWith("${PLUGIN_ROOT}/")) {
      const relative = raw.cwd.slice("${PLUGIN_ROOT}".length).replace(/^\//, "") || "."
      if (resolvedKind(tree, relative) !== "directory") return undefined
    } else if (raw.cwd === "${PLUGIN_DATA}" || raw.cwd.startsWith("${PLUGIN_DATA}/")) {
      const relative = raw.cwd.slice("${PLUGIN_DATA}".length).replace(/^\//, "")
      if (relative.split("/").includes("..")) return undefined
    } else return undefined
  }
  return {
    name,
    type: "stdio",
    command: raw.command,
    ...(Array.isArray(raw.args) ? { args: raw.args } : {}),
    ...(stringRecord(raw.env) ? { env: raw.env } : {}),
    ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
  }
}

function validateHttpServer(name: string, raw: Record<string, unknown>): AgentPluginHttpServer | undefined {
  if (!noUnknownFields(raw, ["type", "url", "headers"])) return undefined
  if (raw.type !== "streamable-http" && raw.type !== "sse") return undefined
  if (!remoteUrl(raw.url)) return undefined
  if (raw.headers !== undefined && !headers(raw.headers)) return undefined
  return {
    name,
    type: raw.type,
    url: raw.url,
    ...(headers(raw.headers) ? { headers: raw.headers } : {}),
  }
}

function validateMcpServer(tree: AgentPluginTree, name: string, raw: unknown): AgentPluginMcpServer | undefined {
  if (!record(raw)) return undefined
  if (raw.type === "stdio") return validateStdioServer(tree, name, raw)
  if (raw.type === "streamable-http" || raw.type === "sse") return validateHttpServer(name, raw)
  return undefined
}

function loadMcp(tree: AgentPluginTree, diagnostics: AgentPluginDiagnostic[]) {
  const kind = resolvedKind(tree, "mcp.json")
  if (kind === "missing") return { status: "absent" as const, servers: [] }
  if (kind !== "file") {
    diagnostics.push({ code: "mcp_invalid", path: "mcp.json", message: "mcp.json must resolve to a regular file inside the plugin root" })
    return { status: "invalid" as const, servers: [] }
  }

  let raw: unknown
  try {
    raw = json(tree, "mcp.json")
  } catch {
    diagnostics.push({ code: "mcp_invalid", path: "mcp.json", message: "mcp.json is not valid JSON" })
    return { status: "invalid" as const, servers: [] }
  }
  if (!record(raw)
    || raw.$schema !== AGENT_PLUGIN_MCP_SCHEMA
    || !record(raw.mcpServers)
    || !noUnknownFields(raw, ["$schema", "mcpServers"])) {
    diagnostics.push({ code: "mcp_invalid", path: "mcp.json", message: "mcp.json does not satisfy the Agent Plugins v1 top-level schema" })
    return { status: "invalid" as const, servers: [] }
  }

  const servers: AgentPluginMcpServer[] = []
  for (const [name, value] of Object.entries(raw.mcpServers).toSorted(([a], [b]) => a.localeCompare(b))) {
    const server = validateMcpServer(tree, name, value)
    if (server) servers.push(server)
    else diagnostics.push({ code: "mcp_server_invalid", path: `mcp.json#/mcpServers/${name}`, message: `MCP server ${name} is invalid` })
  }
  return { status: "valid" as const, servers }
}

export function validatePluginTree(tree: AgentPluginTree, rootLabel = "."): AgentPluginValidationResult {
  const diagnostics: AgentPluginDiagnostic[] = []
  if (resolvedKind(tree, "plugin.json") !== "file") {
    return { status: "invalid", diagnostics: [{ code: "manifest_invalid", path: "plugin.json", message: "plugin.json must resolve to a regular file inside the plugin root" }] }
  }

  let raw: unknown
  try {
    raw = json(tree, "plugin.json")
  } catch {
    return { status: "invalid", diagnostics: [{ code: "manifest_invalid", path: "plugin.json", message: "plugin.json is not valid JSON" }] }
  }
  const manifest = validateManifest(raw)
  diagnostics.push(...manifest.diagnostics)
  if (!manifest.manifest) return { status: "invalid", diagnostics }

  const skills = loadSkills(tree, diagnostics)
  const mcp = loadMcp(tree, diagnostics)
  return {
    status: "valid",
    plugin: { root: rootLabel, manifest: manifest.manifest, skills, mcp },
    diagnostics,
  }
}
