import {
  AgentRuntimeContractError,
  assertAgentExecutionBinding,
  connectionIdForHarness,
  type AgentExecutionBinding,
} from "@claxedo/agent-runtime-contract"
import type { RuntimeDirectory, SessionHarness } from "../index"
import type { AgentRuntimeStoreWithRecovery } from "../harnesses/shared/runtime-store"
import type { AgentRuntimeSessionCreateInput } from "./contracts"

export const normalizeDirectory = (directory: RuntimeDirectory) => directory ?? ""

export function requireExecutionBinding(
  store: AgentRuntimeStoreWithRecovery,
  sessionId: string,
  directory?: RuntimeDirectory,
  expectedHarness?: SessionHarness,
): AgentExecutionBinding {
  const binding = store.getExecutionBinding(sessionId)
  if (!binding) {
    throw new AgentRuntimeContractError({
      code: "invalid_execution_binding",
      field: "upstreamSessionId",
      message: `Session ${sessionId} has no complete execution binding`,
    })
  }
  const session = store.getSession(sessionId)
  const config = store.getSessionConfig(sessionId)
  if (!session || !config) {
    throw new AgentRuntimeContractError({
      code: "invalid_execution_binding",
      field: !session ? "sessionId" : "connectionId",
      message: `Session ${sessionId} has no complete execution binding`,
    })
  }
  return assertAgentExecutionBinding(binding, {
    ...binding,
    sessionId,
    directory: normalizeDirectory(directory ?? session.directory),
    connectionId: connectionIdForHarness(expectedHarness ?? config.harness),
  })
}

export function assertSessionCreateBindingScope(
  store: AgentRuntimeStoreWithRecovery,
  sessionId: string,
  create: AgentRuntimeSessionCreateInput,
): void {
  const existing = store.getExecutionBinding(sessionId)
  if (!store.getSession(sessionId) && !existing) return
  if (!existing) {
    throw new AgentRuntimeContractError({
      code: "invalid_execution_binding",
      field: "upstreamSessionId",
      message: `Session ${sessionId} has no complete execution binding`,
    })
  }
  assertAgentExecutionBinding(existing, {
    ...existing,
    scope: "workspace",
    sessionId,
    workspaceId: create.workspaceId,
    directory: normalizeDirectory(create.directory),
    connectionId: connectionIdForHarness(create.harness),
  })
}
