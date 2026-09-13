import fs from "fs"
import path from "path"
import type { McpServer } from "@agentclientprotocol/sdk"
import { asRecordOrEmpty } from "@claxedo/helpers/guards"
import { dataDir } from "./paths"
import { asRecord, isRecord } from "@claxedo/agent-runtime-contract"
import { normalizeHarnessIdentity } from "@claxedo/agent-runtime-contract"

// Resolve storage paths at operation time because the data directory is a runtime setting.
const claxedoDir = () => dataDir()
const overridesFile = () => path.join(claxedoDir(), "managed-mcp-overrides.json")

export const MCP_CAPABLE_AGENTS = ["claude", "codex", "gemini", "cursor"] as const
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
export type ManagedMcpState = {
  port: number
  defaults: Record<ManagedMcpServer, Record<McpCapableAgent, boolean>>
  overrides: ManagedMcpOverrides
  servers: Record<ManagedMcpServer, Record<McpCapableAgent, boolean>>
}

const row = (value: unknown): Record<string, unknown> => asRecord(value) ?? {}

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

const defaults = (): Record<ManagedMcpServer, Record<McpCapableAgent, boolean>> => ({})

/** Every capable agent, off. The registry's inner map is complete by contract. */
const noAgents = (): Record<McpCapableAgent, boolean> => ({ claude: false, codex: false, gemini: false, cursor: false })

  const loadAgents = (value?: unknown): Partial<Record<McpCapableAgent, boolean>> => {
    const root = asRecordOrEmpty(value)
    const out: Partial<Record<McpCapableAgent, boolean>> = {}
  for (const agent of MCP_CAPABLE_AGENTS) {
    const next = root[agent]
    if (typeof next === "boolean") out[agent] = next
  }
  return out
}

const normalizeOverrides = (value?: unknown) => {
  const root = asRecordOrEmpty(value)
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
  const out = defaults()
  for (const server of MANAGED_MCP_SERVERS) {
    const agents = out[server] ??= noAgents()
    for (const agent of MCP_CAPABLE_AGENTS) {
      const next = overrides[server]?.[agent]
      if (typeof next === "boolean") agents[agent] = next
    }
  }
  return out
}

export const isManagedMcpServer = (value: string): value is ManagedMcpServer =>
  MANAGED_MCP_SERVERS.includes(value)

export const mcpControl = (agent: McpCapableAgent): ManagedMcpControl => {
  if (agent === "gemini") return "generated-config"
  return "managed"
}

/** Sound because `MCP_CAPABLE_AGENTS` is the tuple `McpCapableAgent` is derived from. */
const isMcpCapableAgent = (value: string): value is McpCapableAgent =>
  (MCP_CAPABLE_AGENTS as readonly string[]).includes(value)

export const harnessAgent = (type: string): McpCapableAgent | null => {
  const agent = normalizeHarnessIdentity(type)?.id
  return agent && isMcpCapableAgent(agent) ? agent : null
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
    const json = row(JSON.parse(raw))
    return {
      port: typeof json.port === "number" ? json.port : defaultPort,
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

/** Servers a config payload declares, parsed rather than asserted. */
export function resolvedMcpServers(value: unknown): Record<string, ResolvedMcpServer> | undefined {
  const servers = asRecord(value)
  if (!servers) return undefined
  return Object.fromEntries(
    Object.entries(servers).flatMap(([name, server]) => (isResolvedMcpServer(server) ? [[name, server]] : [])),
  )
}

function isResolvedMcpServer(value: unknown): value is ResolvedMcpServer {
  if (!isRecord(value) || typeof value.name !== "string") return false
  if (value.transport === "stdio") return typeof value.command === "string" && Array.isArray(value.args) && isRecord(value.env)
  return value.transport === "remote" && typeof value.url === "string" && isRecord(value.headers)
}
