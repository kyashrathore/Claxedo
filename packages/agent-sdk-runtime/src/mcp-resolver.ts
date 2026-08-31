import fs from "fs"
import path from "path"
import type { McpServer } from "@agentclientprotocol/sdk"
import { dataDir } from "./paths"
import { normalizeHarnessIdentity } from "./harness-types"

// Resolve storage paths at operation time because the data directory is a runtime setting.
const claxedoDir = () => dataDir()
const overridesFile = () => path.join(claxedoDir(), "managed-mcp-overrides.json")

export const MCP_CAPABLE_AGENTS = ["opencode", "claude", "codex", "gemini", "cursor"] as const
export type McpCapableAgent = (typeof MCP_CAPABLE_AGENTS)[number]

export type ManagedMcpServer = string
export type UserMcpServer = {
  type: "stdio" | "remote"
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  disabled?: boolean
}

// The host can populate this registry when it owns managed MCP servers.
export const MANAGED_MCP_SERVERS: readonly ManagedMcpServer[] = []

export type ManagedMcpControl = "managed" | "generated-config" | "external-unmanaged"
export type ManagedMcpApply = "applied" | "blocked" | "disabled" | "external-unmanaged"

export type ResolvedMcpServer =
  | {
      name: string
      source: "managed" | "user"
      transport: "stdio"
      command: string
      args: string[]
      env: Record<string, string>
    }
  | {
      name: string
      source: "user"
      transport: "remote"
      url: string
      headers: Record<string, string>
    }

export type ManagedMcpStatus = {
  default: boolean
  override: boolean | null
  enabled: boolean
  control: ManagedMcpControl
  apply: ManagedMcpApply
  error?: string
}

export type ManagedMcpOverrides = Partial<Record<ManagedMcpServer, Partial<Record<McpCapableAgent, boolean>>>>
export type McpControlOptions = {
  externalOpencode?: boolean
}

export type ManagedMcpState = {
  port: number
  defaults: Record<ManagedMcpServer, Record<McpCapableAgent, boolean>>
  overrides: ManagedMcpOverrides
  servers: Record<ManagedMcpServer, Record<McpCapableAgent, boolean>>
}

const asRecord = (value: unknown) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

const defaults = (): Record<ManagedMcpServer, Record<McpCapableAgent, boolean>> => ({})

const clone = () => JSON.parse(JSON.stringify(defaults())) as Record<ManagedMcpServer, Record<McpCapableAgent, boolean>>

const loadAgents = (value?: unknown) => {
  const root = asRecord(value)
  const out = {} as Record<McpCapableAgent, boolean>
  for (const agent of MCP_CAPABLE_AGENTS) {
    const next = root[agent]
    if (typeof next === "boolean") out[agent] = next
  }
  return out
}

const normalizeOverrides = (value?: unknown) => {
  const root = asRecord(value)
  const out: ManagedMcpOverrides = {}
  for (const server of MANAGED_MCP_SERVERS) {
    const agents = loadAgents(root[server])
    if (Object.keys(agents).length > 0) out[server] = agents
  }
  return out
}

const apply = (
  base: Record<ManagedMcpServer, Record<McpCapableAgent, boolean>>,
  overrides: ManagedMcpOverrides,
) => {
  const out = clone()
  for (const server of MANAGED_MCP_SERVERS) {
    const agents = out[server] ??= {} as Record<McpCapableAgent, boolean>
    for (const agent of MCP_CAPABLE_AGENTS) {
      const next = overrides[server]?.[agent]
      if (typeof next === "boolean") agents[agent] = next
    }
  }
  return out
}

export const isManagedMcpServer = (value: string): value is ManagedMcpServer =>
  MANAGED_MCP_SERVERS.includes(value as ManagedMcpServer)

export const mcpControl = (agent: McpCapableAgent, options: McpControlOptions = {}): ManagedMcpControl => {
  if (agent === "gemini") return "generated-config"
  if (agent === "opencode" && options.externalOpencode) return "external-unmanaged"
  return "managed"
}

export const harnessAgent = (type: string): McpCapableAgent | null => {
  const agent = normalizeHarnessIdentity(type)?.id
  if (!agent || !(MCP_CAPABLE_AGENTS as readonly string[]).includes(agent)) return null
  return agent as McpCapableAgent
}

const resolveManaged = (
  server: ManagedMcpServer,
  _port: number,
  _agent: McpCapableAgent,
): ResolvedMcpServer => {
  throw new Error(`Managed MCP server '${server}' has no resolver`)
}

const resolveUser = (input: Record<string, UserMcpServer>) => {
  const out: Record<string, ResolvedMcpServer> = {}
  for (const [name, cfg] of Object.entries(input)) {
    if (cfg.disabled) continue
    if (cfg.type === "stdio" && cfg.command) {
      out[name] = {
        name,
        source: "user",
        transport: "stdio",
        command: cfg.command,
        args: cfg.args ?? [],
        env: cfg.env ?? {},
      }
      continue
    }
    if (cfg.type === "remote" && cfg.url) {
      out[name] = {
        name,
        source: "user",
        transport: "remote",
        url: cfg.url,
        headers: cfg.headers ?? {},
      }
    }
  }
  return out
}

export const resolveUserMcp = resolveUser

const readState = async (defaultPort = 7860) => {
  try {
    const raw = await fs.promises.readFile(overridesFile(), "utf-8")
    const json = JSON.parse(raw) as { port?: number; overrides?: unknown }
    return {
      port: json.port ?? defaultPort,
      overrides: normalizeOverrides(json.overrides),
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
  }

  return {
    port: defaultPort,
    overrides: {} as ManagedMcpOverrides,
  }
}

export async function loadManagedMcpState(port = 7860): Promise<ManagedMcpState> {
  const row = await readState(port)
  const base = defaults()
  return {
    port: row.port,
    defaults: base,
    overrides: row.overrides,
    servers: apply(base, row.overrides),
  }
}

export function describeManagedMcp(
  state: ManagedMcpState,
  server: ManagedMcpServer,
  agent: McpCapableAgent,
  control: ManagedMcpControl,
): ManagedMcpStatus {
  const def = state.defaults[server]?.[agent] ?? false
  const over = state.overrides[server]?.[agent]
  const enabled = state.servers[server]?.[agent] ?? false
  if (!enabled) {
    return {
      default: def,
      override: typeof over === "boolean" ? over : null,
      enabled,
      control,
      apply: "disabled",
    }
  }
  if (control === "external-unmanaged") {
    return {
      default: def,
      override: typeof over === "boolean" ? over : null,
      enabled,
      control,
      apply: "external-unmanaged",
    }
  }
  try {
    resolveManaged(server, state.port, agent)
    return {
      default: def,
      override: typeof over === "boolean" ? over : null,
      enabled,
      control,
      apply: "applied",
    }
  } catch (err) {
    return {
      default: def,
      override: typeof over === "boolean" ? over : null,
      enabled,
      control,
      apply: "blocked",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function resolveManagedMcp(input: {
  state: ManagedMcpState
  agent: McpCapableAgent
  control: ManagedMcpControl
  strict?: boolean
}) {
  const out: Record<string, ResolvedMcpServer> = {}
  const status = {} as Record<ManagedMcpServer, ManagedMcpStatus>
  for (const server of MANAGED_MCP_SERVERS) {
    const item = describeManagedMcp(input.state, server, input.agent, input.control)
    status[server] = item
    if (item.apply === "applied") {
      out[server] = resolveManaged(server, input.state.port, input.agent)
      continue
    }
    if (item.apply === "blocked" && input.strict && input.control !== "external-unmanaged") {
      throw new Error(item.error ?? `Managed MCP '${server}' is blocked for '${input.agent}'`)
    }
  }
  return { mcp: out, status }
}

export function resolveEffectiveMcp(input: {
  state: ManagedMcpState
  agent: McpCapableAgent
  control: ManagedMcpControl
  userMcp?: Record<string, UserMcpServer>
  strict?: boolean
}) {
  const managed = resolveManagedMcp(input)
  return {
    mcp: {
      ...managed.mcp,
      ...resolveUser(input.userMcp ?? {}),
    },
    status: managed.status,
  }
}

export function toOpencodeConfig(mcp: Record<string, ResolvedMcpServer>) {
  const out: Record<string, unknown> = {}
  for (const [name, cfg] of Object.entries(mcp)) {
    if (cfg.transport === "stdio") {
      out[name] = {
        type: "local",
        command: [cfg.command, ...cfg.args],
        environment: cfg.env,
      }
      continue
    }
    out[name] = {
      type: "remote",
      url: cfg.url,
      headers: cfg.headers,
    }
  }
  if (!Object.keys(out).length) return {}
  return { mcp: out }
}

export function toAcpMcpServers(mcp: Record<string, ResolvedMcpServer>): McpServer[] {
  return Object.values(mcp).map((cfg) => {
    if (cfg.transport === "stdio") {
      return {
        name: cfg.name,
        command: cfg.command,
        args: cfg.args,
        env: Object.entries(cfg.env).map(([name, value]) => ({ name, value })),
      } satisfies McpServer
    }
    return {
      type: "http",
      name: cfg.name,
      url: cfg.url,
      headers: Object.entries(cfg.headers).map(([name, value]) => ({ name, value })),
    } satisfies McpServer
  })
}

export function shellCommand(path: string) {
  return `bash ${shellQuote(path)}`
}
