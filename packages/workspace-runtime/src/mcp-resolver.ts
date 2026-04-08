import fs from "fs"
import path from "path"
import type { McpServer } from "@agentclientprotocol/sdk"
import type { UserMcpServer } from "./agent-config"
import { Log } from "./log"
import { dataDir } from "./paths"

const log = Log.create({ service: "mcp-resolver" })

const CLAXEDO_DIR = dataDir()
const OVERRIDES_FILE = path.join(CLAXEDO_DIR, "managed-mcp-overrides.json")
const LEGACY_FILE = path.join(CLAXEDO_DIR, "mcp-agents.json")

export const MCP_CAPABLE_AGENTS = ["opencode", "claude", "codex", "gemini", "cursor"] as const
export type McpCapableAgent = (typeof MCP_CAPABLE_AGENTS)[number]

export const MANAGED_MCP_SERVERS = ["claxedo-mcp"] as const
export type ManagedMcpServer = (typeof MANAGED_MCP_SERVERS)[number]

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

const asRecord = (value: unknown) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

const tsxLoader = () => {
  const list = [
    path.resolve(import.meta.dirname, "../node_modules/tsx/dist/loader.mjs"),
    path.resolve(import.meta.dirname, "../../claxedo-server/node_modules/tsx/dist/loader.mjs"),
  ]
  for (const file of list) {
    try {
      if (fs.existsSync(file)) return file
    } catch {}
  }
}

const defaults = () => ({
  "claxedo-mcp": {
    opencode: true,
    claude: true,
    codex: true,
    gemini: true,
    cursor: true,
  },
}) satisfies Record<ManagedMcpServer, Record<McpCapableAgent, boolean>>

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

const diff = (
  base: Record<ManagedMcpServer, Record<McpCapableAgent, boolean>>,
  next: Record<ManagedMcpServer, Record<McpCapableAgent, boolean>>,
) => {
  const out: ManagedMcpOverrides = {}
  for (const server of MANAGED_MCP_SERVERS) {
    for (const agent of MCP_CAPABLE_AGENTS) {
      if (next[server][agent] === base[server][agent]) continue
      out[server] ??= {}
      out[server]![agent] = next[server][agent]
    }
  }
  return out
}

const apply = (
  base: Record<ManagedMcpServer, Record<McpCapableAgent, boolean>>,
  overrides: ManagedMcpOverrides,
) => {
  const out = clone()
  for (const server of MANAGED_MCP_SERVERS) {
    for (const agent of MCP_CAPABLE_AGENTS) {
      const next = overrides[server]?.[agent]
      if (typeof next === "boolean") out[server][agent] = next
    }
  }
  return out
}

const legacyAgents = (value?: unknown) => {
  const root = asRecord(value)
  const out = {} as Record<McpCapableAgent, boolean>
  for (const agent of MCP_CAPABLE_AGENTS) {
    const next = root[agent]
    if (typeof next === "boolean") out[agent] = next
  }
  return out
}

const legacyServers = (value?: unknown) => {
  const root = asRecord(value)
  const out = clone()
  const old = legacyAgents(asRecord(value).agents)
  for (const server of MANAGED_MCP_SERVERS) {
    const agents = legacyAgents(root[server])
    for (const agent of MCP_CAPABLE_AGENTS) {
      const next = agents[agent]
      if (typeof next === "boolean") {
        out[server][agent] = next
        continue
      }
      if (server === "claxedo-mcp" && typeof old[agent] === "boolean") {
        out[server][agent] = old[agent]
      }
    }
  }
  return out
}

export const isManagedMcpServer = (value: string): value is ManagedMcpServer =>
  MANAGED_MCP_SERVERS.includes(value as ManagedMcpServer)

export const mcpControl = (agent: McpCapableAgent): ManagedMcpControl => {
  if (agent === "gemini") return "generated-config"
  if (agent === "opencode" && process.env.OPENCODE_URL) return "external-unmanaged"
  return "managed"
}

export const runnerAgent = (type: string): McpCapableAgent | null => {
  if (type === "opencode") return "opencode"
  if (type === "claude-acp") return "claude"
  if (type === "codex-acp") return "codex"
  if (type === "cursor-acp") return "cursor"
  return null
}

/**
 * Resolve the claxedo-mcp command.
 *
 * Checks four locations in order:
 * 1. JS bundle sibling of process.execPath
 * 2. Tauri resource paths
 * 3. Compiled binary sibling
 * 4. Dev entrypoint via Node + tsx
 */
export function resolveClaxedoMcpCommand(options: { execPath?: string; devPath?: string } = {}): string[] {
  const execPath = options.execPath ?? process.execPath
  const execDir = path.dirname(execPath)
  const devPath = options.devPath ?? path.resolve(import.meta.dirname, "../../claxedo-server/src/mcp/claxedo-mcp-dev.ts")
  const probe = (file: string) => {
    try {
      if (fs.existsSync(file)) {
        log.info("Resolved claxedo-mcp JS bundle", { path: file })
        return [execPath, file]
      }
    } catch {}
  }

  const local = probe(path.join(execDir, "claxedo-mcp.js"))
  if (local) return local

  const tauri = [
    path.join(execDir, "sidecars", "claxedo-mcp.js"),
    path.resolve(execDir, "..", "Resources", "sidecars", "claxedo-mcp.js"),
  ]
  for (const file of tauri) {
    const hit = probe(file)
    if (hit) return hit
  }

  try {
    const dir = path.resolve(execDir, "..", "lib")
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const hit = probe(path.join(dir, entry.name, "sidecars", "claxedo-mcp.js"))
      if (hit) return hit
    }
  } catch {}

  try {
    for (const entry of fs.readdirSync(execDir)) {
      if (entry !== "claxedo-mcp" && !entry.startsWith("claxedo-mcp-")) continue
      const file = path.join(execDir, entry)
      try {
        fs.accessSync(file, fs.constants.X_OK)
        log.info("Resolved claxedo-mcp from sidecar directory", { path: file })
        return [file]
      } catch {}
    }
  } catch {}

  try {
    if (fs.existsSync(devPath)) {
      const loader = tsxLoader()
      if (loader) return [execPath, "--import", loader, devPath]
      log.warn("Could not resolve tsx loader for claxedo-mcp dev entrypoint", { devPath })
    }
  } catch {}

  log.warn("Could not resolve claxedo-mcp binary or dev entrypoint")
  return []
}

export function getClaxedoMcpStdioConfig(
  port: number,
  options?: Parameters<typeof resolveClaxedoMcpCommand>[0],
) {
  const cmd = resolveClaxedoMcpCommand(options)
  if (!cmd.length) return null
  return {
    command: cmd[0],
    args: cmd.slice(1),
    env: {
      OPENCODE_API_URL: `http://localhost:${port}`,
    },
  }
}

export function requireClaxedoMcpStdioConfig(
  port: number,
  agent: McpCapableAgent,
  options?: Parameters<typeof resolveClaxedoMcpCommand>[0],
) {
  const cfg = getClaxedoMcpStdioConfig(port, options)
  if (cfg) return cfg
  throw new Error(
    `Managed MCP server 'claxedo-mcp' is enabled for '${agent}', but Claxedo could not resolve a runnable claxedo-mcp command.`,
  )
}

const resolveManaged = (server: ManagedMcpServer, port: number, agent: McpCapableAgent): ResolvedMcpServer => {
  switch (server) {
    case "claxedo-mcp": {
      const cfg = requireClaxedoMcpStdioConfig(port, agent)
      return {
        name: server,
        source: "managed",
        transport: "stdio",
        command: cfg.command,
        args: cfg.args,
        env: cfg.env,
      }
    }
  }
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

const readState = async (fallback = 7860) => {
  try {
    const raw = await fs.promises.readFile(OVERRIDES_FILE, "utf-8")
    const json = JSON.parse(raw) as { port?: number; overrides?: unknown }
    return {
      port: json.port ?? fallback,
      overrides: normalizeOverrides(json.overrides),
    }
  } catch {}

  try {
    const raw = await fs.promises.readFile(LEGACY_FILE, "utf-8")
    const json = JSON.parse(raw) as { port?: number; servers?: unknown; agents?: unknown }
    const next = legacyServers({ ...asRecord(json.servers), agents: json.agents })
    return {
      port: json.port ?? fallback,
      overrides: diff(defaults(), next),
    }
  } catch {}

  return {
    port: fallback,
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

export async function saveManagedMcpState(state: ManagedMcpState) {
  await fs.promises.mkdir(CLAXEDO_DIR, { recursive: true, mode: 0o755 })
  await fs.promises.writeFile(OVERRIDES_FILE, JSON.stringify({
    port: state.port,
    overrides: state.overrides,
  }, null, 2) + "\n", { mode: 0o644 })
}

export async function setManagedMcpOverride(server: ManagedMcpServer, agent: McpCapableAgent, enabled: boolean, port?: number) {
  const state = await loadManagedMcpState(port)
  const next = state.defaults[server][agent]
  if (enabled === next) {
    delete state.overrides[server]?.[agent]
    if (state.overrides[server] && Object.keys(state.overrides[server]!).length === 0) {
      delete state.overrides[server]
    }
  } else {
    state.overrides[server] ??= {}
    state.overrides[server]![agent] = enabled
  }
  state.port = port ?? state.port
  state.servers = apply(state.defaults, state.overrides)
  await saveManagedMcpState(state)
  return state
}

export function describeManagedMcp(
  state: ManagedMcpState,
  server: ManagedMcpServer,
  agent: McpCapableAgent,
  control: ManagedMcpControl,
): ManagedMcpStatus {
  const def = state.defaults[server][agent]
  const over = state.overrides[server]?.[agent]
  const enabled = state.servers[server][agent]
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
