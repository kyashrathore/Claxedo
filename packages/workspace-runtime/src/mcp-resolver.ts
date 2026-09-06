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
import { num, rec } from "./json-value"

export * from "@claxedo/agent-sdk-runtime/mcp-resolver"

const runtimeDataDir = () => dataDir()
const overridesFile = () => path.join(runtimeDataDir(), "managed-mcp-overrides.json")

/**
 * A plain boolean, not a type predicate: `ManagedMcpServer` is an alias for
 * `string` upstream, so `value is ManagedMcpServer` narrowed nothing on the
 * true branch and narrowed the FALSE branch to `never` — which is why the
 * "unknown server" message could not interpolate the name it was reporting.
 */
function isManagedMcpServer(value: string): boolean {
  return MANAGED_MCP_SERVERS.includes(value)
}

function apply(
  defaults: Record<ManagedMcpServer, Record<McpCapableAgent, boolean>>,
  overrides: ManagedMcpOverrides,
) {
  // Filled key by key: `Object.fromEntries` widens the value type, which is
  // what forced the whole record to be asserted afterwards.
  const merged: Record<ManagedMcpServer, Record<McpCapableAgent, boolean>> = {}
  for (const server of MANAGED_MCP_SERVERS) {
    merged[server] = { ...defaults[server], ...overrides[server] }
  }
  return merged
}

function normalizeOverrides(value?: unknown) {
  const root = rec(value) ?? {}
  const out: ManagedMcpOverrides = {}
  for (const server of MANAGED_MCP_SERVERS) {
    const agents = rec(root[server]) ?? {}
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
    const json = rec(JSON.parse(raw))
    return {
      port: num(json?.port) ?? fallback,
      overrides: normalizeOverrides(json?.overrides),
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
    if (state.overrides[server] && Object.keys(state.overrides[server]).length === 0) {
      delete state.overrides[server]
    }
  } else {
    state.overrides[server] ??= {}
    state.overrides[server][agent] = enabled
  }
  state.port = port ?? state.port
  state.servers = apply(state.defaults, state.overrides)
  await saveManagedMcpState(state)
  return state
}
