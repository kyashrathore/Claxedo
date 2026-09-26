import { asRecord } from "@claxedo/helpers/guards"
import {
  createHarnessConnectionSchema,
  explicitDefaultHarness,
  isConnectionId,
  isNativeHarnessId,
} from "./connections"
import type { UserAgentConfig } from "./config"
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
