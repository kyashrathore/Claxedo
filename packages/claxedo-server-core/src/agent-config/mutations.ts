import { asRecord } from "@claxedo/helpers/guards"
import { jsonStringRecord } from "../platform/runtime/lib/json"
import {
  createHarnessConnectionSchema,
  explicitDefaultHarness,
  isConnectionId,
  isNativeHarnessId,
} from "./connections"
import type { UserAgentConfig, UserMcpServer } from "./config"
import type { UserAgentConfigStore } from "./repository"
import type { RuntimeHarnessSelection } from "@claxedo/workspace-runtime/config"

const connections = createHarnessConnectionSchema()

export class AgentConfigMutationError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message)
  }
}

export async function putConnection(store: UserAgentConfigStore, connectionId: string, body: unknown) {
  if (!asRecord(body)) throw new AgentConfigMutationError("agent_config_invalid_body", "Invalid JSON body")
  const config = await store.read()
  const proposed = connections.validate({ ...config.connections, [connectionId]: body })
  if (proposed.problems.length) {
    throw new AgentConfigMutationError("agent_config_connection_invalid", proposed.problems.map((item) => item.problem).join("; "))
  }
  const revisions = connections.revisionProblems(config.connections, proposed.accepted)
  if (revisions.length) {
    throw new AgentConfigMutationError("agent_config_connection_invalid", revisions.map((item) => item.problem).join("; "))
  }
  await store.write({ ...config, connections: proposed.accepted })
  return connections.publicRows(proposed.accepted)
}

export async function deleteConnection(store: UserAgentConfigStore, connectionId: string) {
  const config = await store.read()
  if (!(connectionId in config.connections)) {
    throw new AgentConfigMutationError("agent_config_connection_not_found", "Agent connection not found", 404)
  }
  const connections = Object.fromEntries(Object.entries(config.connections).filter(([id]) => id !== connectionId))
  const { defaultConnectionId: _, ...rest } = config
  await store.write({ ...rest, connections, ...(config.defaultConnectionId === connectionId ? {} : {
    defaultConnectionId: config.defaultConnectionId,
  }) })
}

export function connectionRows(config: Pick<UserAgentConfig, "connections">) {
  return connections.publicRows(config.connections)
}

export function parseHarnessSelection(input: unknown): RuntimeHarnessSelection | undefined {
  const row = asRecord(input)
  if (row?.kind === "native" && typeof row.harnessId === "string" && isNativeHarnessId(row.harnessId)) {
    return { kind: "native", harnessId: row.harnessId }
  }
  if (row?.kind === "connection" && typeof row.connectionId === "string" && isConnectionId(row.connectionId)) {
    return { kind: "connection", connectionId: row.connectionId.trim() }
  }
  return undefined
}

export async function setDefaultHarness(store: UserAgentConfigStore, selection: RuntimeHarnessSelection) {
  const config = await store.read()
  let next: UserAgentConfig
  if (selection.kind === "native") {
    const { defaultConnectionId: _, ...rest } = config
    next = { ...rest, defaultHarness: selection }
  } else {
    if (!config.connections[selection.connectionId]?.enabled) {
      throw new AgentConfigMutationError("agent_config_connection_unavailable", `Connection ${selection.connectionId} is not installed and enabled`, 409)
    }
    const { defaultHarness: _, ...rest } = config
    next = { ...rest, defaultConnectionId: selection.connectionId }
  }
  await store.write(next)
  return explicitDefaultHarness(next)
}

export async function putMcpServer(store: UserAgentConfigStore, name: string, body: unknown) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new AgentConfigMutationError("agent_config_mcp_name_invalid", "Invalid server name (alphanumeric, dash, underscore only)")
  }
  const row = asRecord(body)
  if (!row) throw new AgentConfigMutationError("agent_config_invalid_body", "Invalid JSON body")
  const disabled = typeof row.disabled === "boolean" ? { disabled: row.disabled } : {}
  let server: UserMcpServer
  if (row.type === "stdio") {
    if (typeof row.command !== "string") {
      throw new AgentConfigMutationError("agent_config_mcp_command_required", "command is required for stdio servers")
    }
    server = {
      type: "stdio",
      command: row.command,
      args: Array.isArray(row.args) ? row.args.filter((arg): arg is string => typeof arg === "string") : [],
      env: jsonStringRecord(row.env),
      ...disabled,
    }
  } else if (row.type === "remote") {
    if (typeof row.url !== "string") {
      throw new AgentConfigMutationError("agent_config_mcp_url_required", "url is required for remote servers")
    }
    server = { type: "remote", url: row.url, headers: jsonStringRecord(row.headers), ...disabled }
  } else {
    throw new AgentConfigMutationError("agent_config_mcp_type_invalid", "type must be 'stdio' or 'remote'")
  }
  const config = await store.read()
  await store.write({ ...config, mcp: { ...config.mcp, [name]: server } })
  return server
}

export async function deleteMcpServer(store: UserAgentConfigStore, name: string) {
  const config = await store.read()
  if (!(name in config.mcp)) throw new AgentConfigMutationError("agent_config_mcp_not_found", "MCP server not found", 404)
  await store.write({ ...config, mcp: Object.fromEntries(Object.entries(config.mcp).filter(([id]) => id !== name)) })
}
