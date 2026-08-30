import type { AgentExecutionBinding, AgentExecutionBindingField } from "./sessions"

export const AGENT_RUNTIME_ERROR_CODES = [
  "selection_required",
  "harness_unavailable",
  "workspace_offline",
  "unsupported_operation",
  "replay_gap",
  "upstream_error",
  "invalid_execution_binding",
] as const

export type AgentRuntimeErrorCode = (typeof AGENT_RUNTIME_ERROR_CODES)[number]

export type AgentRuntimeError =
  | { code: "selection_required"; message: string; selection: "harness" | "model" }
  | { code: "harness_unavailable"; message: string; connectionId: string }
  | { code: "workspace_offline"; message: string; workspaceId: string }
  | { code: "unsupported_operation"; message: string; operation: string }
  | { code: "replay_gap"; message: string; cursor: string }
  | { code: "upstream_error"; message: string; connectionId?: string }
  | { code: "invalid_execution_binding"; message: string; field: AgentExecutionBindingField }

export type ClientResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AgentRuntimeError }

export class AgentRuntimeContractError extends Error {
  constructor(readonly detail: AgentRuntimeError) {
    super(detail.message)
    this.name = "AgentRuntimeContractError"
  }
}

const BINDING_FIELDS = ["sessionId", "workspaceId", "directory", "connectionId", "upstreamSessionId"] as const

export function assertAgentExecutionBinding(
  binding: Readonly<AgentExecutionBinding>,
  expected: Readonly<AgentExecutionBinding> = binding,
): AgentExecutionBinding {
  for (const field of BINDING_FIELDS) {
    if (typeof binding[field] !== "string" || field !== "directory" && binding[field].trim() === "") {
      throw new AgentRuntimeContractError({
        code: "invalid_execution_binding",
        field,
        message: `execution binding ${field} is required`,
      })
    }
    if (binding[field] !== expected[field]) {
      throw new AgentRuntimeContractError({
        code: "invalid_execution_binding",
        field,
        message: `execution binding ${field} mismatch`,
      })
    }
  }
  return binding as AgentExecutionBinding
}
