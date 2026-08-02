import fs from "fs"
import path from "path"
import {
  MANAGED_MCP_SERVERS,
  type ManagedMcpOverrides,
  type ManagedMcpServer,
  type ManagedMcpState,
  type McpCapableAgent,
} from "@claxedo/agent-sdk-runtime/mcp-resolver"
import { dataDir } from "./paths"

export * from "@claxedo/agent-sdk-runtime/mcp-resolver"

const runtimeDataDir = () => dataDir()
const overridesFile = () => path.join(runtimeDataDir(), "managed-mcp-overrides.json")

function isManagedMcpServer(value: string): value is ManagedMcpServer {
  return MANAGED_MCP_SERVERS.includes(value as ManagedMcpServer)
}

function apply(
  defaults: Record<ManagedMcpServer, Record<McpCapableAgent, boolean>>,
  overrides: ManagedMcpOverrides,
) {
  return Object.fromEntries(
    Object.entries(defaults).map(([server, agents]) => [
      server,
      { ...agents, ...(overrides[server] ?? {}) },
    ]),
  ) as Record<ManagedMcpServer, Record<McpCapableAgent, boolean>>
}

function normalizeOverrides(value?: unknown) {
  const root = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const out: ManagedMcpOverrides = {}
  for (const server of MANAGED_MCP_SERVERS) {
    const agents = typeof root[server] === "object" && root[server] !== null && !Array.isArray(root[server])
      ? root[server] as Record<string, unknown>
      : {}
    const enabled = Object.fromEntries(
      Object.entries(agents).filter((entry): entry is [McpCapableAgent, boolean] => typeof entry[1] === "boolean"),
    )
    if (Object.keys(enabled).length > 0) out[server] = enabled
  }
  return out
}

async function readState(fallback = 7860) {
  try {
    const raw = await fs.promises.readFile(overridesFile(), "utf-8")
    const json = JSON.parse(raw) as { port?: number; overrides?: unknown }
    return {
      port: json.port ?? fallback,
      overrides: normalizeOverrides(json.overrides),
    }
  } catch {}

  return {
    port: fallback,
    overrides: {} as ManagedMcpOverrides,
  }
}

export async function loadManagedMcpState(port = 7860): Promise<ManagedMcpState> {
  const state = await readState(port)
  const defaults = {} as Record<ManagedMcpServer, Record<McpCapableAgent, boolean>>
  return {
    port: state.port,
    defaults,
    overrides: state.overrides,
    servers: apply(defaults, state.overrides),
  }
}

export async function saveManagedMcpState(state: ManagedMcpState) {
  await fs.promises.mkdir(runtimeDataDir(), { recursive: true, mode: 0o755 })
  await fs.promises.writeFile(overridesFile(), JSON.stringify({
    port: state.port,
    overrides: state.overrides,
  }, null, 2) + "\n", { mode: 0o644 })
}

export async function setManagedMcpOverride(server: ManagedMcpServer, agent: McpCapableAgent, enabled: boolean, port?: number) {
  if (!isManagedMcpServer(server)) throw new Error(`Unknown managed MCP server: ${server}`)
  const state = await loadManagedMcpState(port)
  const base = state.defaults[server]
  if (!base) throw new Error(`Unknown managed MCP server: ${server}`)
  const next = base[agent]
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
