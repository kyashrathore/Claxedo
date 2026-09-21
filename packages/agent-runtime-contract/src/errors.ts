import type { AgentExecutionBinding, AgentExecutionBindingExpectation, AgentExecutionBindingField } from "./sessions"

export const AGENT_RUNTIME_ERROR_CODES = [
  "selection_required",
  "harness_unavailable",
  "workspace_offline",
  "unsupported_operation",
  "replay_gap",
  "upstream_error",
  "invalid_execution_binding",
] as const

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

/** The binding is complete: workspace-scoped and every field a non-empty string. */
export function requireAgentExecutionBinding(
  binding: Readonly<AgentExecutionBinding>,
): AgentExecutionBinding {
  if (binding.scope !== undefined && binding.scope !== "workspace") {
    throw new AgentRuntimeContractError({ code: "invalid_execution_binding", field: "scope", message: "workspace execution scope is required" })
  }
  for (const field of BINDING_FIELDS) {
    const value = binding[field]
    if (typeof value !== "string" || value.trim() === "") {
      throw new AgentRuntimeContractError({
        code: "invalid_execution_binding",
        field,
        message: `execution binding ${field} is required`,
      })
    }
  }
  return binding as AgentExecutionBinding
}

/**
 * The binding is complete AND matches the expectation this caller independently
 * holds. `expected` has no default: an expectation copied from the binding
 * itself compares every field to itself and proves nothing.
 */
export function assertAgentExecutionBinding(
  binding: Readonly<AgentExecutionBinding>,
  expected: AgentExecutionBindingExpectation,
): AgentExecutionBinding {
  if ((binding.scope ?? "workspace") !== (expected.scope ?? "workspace")) {
    throw new AgentRuntimeContractError({ code: "invalid_execution_binding", field: "scope", message: "execution binding scope mismatch" })
  }
  const complete = requireAgentExecutionBinding(binding)
  for (const field of BINDING_FIELDS) {
    if (complete[field] !== expected[field]) {
      throw new AgentRuntimeContractError({
        code: "invalid_execution_binding",
        field,
        message: `execution binding ${field} mismatch`,
      })
    }
  }
  return complete
}
