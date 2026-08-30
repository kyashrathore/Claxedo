import { describe, expect, test } from "bun:test"
import {
  AGENT_PRESENTATION_EVENT_TYPES,
  AGENT_RUNTIME_ERROR_CODES,
  assertAgentExecutionBinding,
  type AgentExecutionBinding,
  type AgentPresentationEvent,
  type AgentRuntimeError,
  type ExecutionAvailability,
  type ModelSelection,
} from "./index"

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function assertNever(value: never): never {
  throw new Error(`Unexpected discriminant: ${JSON.stringify(value)}`)
}

describe("agent runtime contract", () => {
  test("round trips only the new canonical session, content, and binding schema", () => {
    const binding: AgentExecutionBinding = {
      sessionId: "session-1",
      workspaceId: "workspace-1",
      directory: "/work/one",
      connectionId: "connection-1",
      upstreamSessionId: "opaque-thread-1",
    }
    const fixture = {
      session: {
        id: binding.sessionId,
        workspaceId: binding.workspaceId,
        directory: binding.directory,
        title: "Canonical session",
        time: { created: 1, updated: 2 },
        executionAvailability: { status: "available" } satisfies ExecutionAvailability,
      },
      message: {
        info: { id: "message-1", sessionID: binding.sessionId, role: "assistant" as const },
        parts: [{ id: "part-1", sessionID: binding.sessionId, messageID: "message-1", type: "text" as const, text: "hello" }],
      },
      binding,
    }

    expect(jsonRoundTrip(fixture)).toEqual(fixture)
    expect(JSON.stringify(fixture)).not.toContain("opencode")
    expect(JSON.stringify(fixture)).not.toContain("provider_session_id")
    expect(JSON.stringify(fixture)).not.toContain("agentSessionId")
  })

  test("keeps model selection and execution availability exhaustive", () => {
    const describeModelSelection = (selection: ModelSelection) => {
      switch (selection.status) {
        case "required": return "required"
        case "optional": return "optional"
        case "unsupported": return "unsupported"
        default: return assertNever(selection)
      }
    }
    const describeAvailability = (availability: ExecutionAvailability) => {
      switch (availability.status) {
        case "available": return "available"
        case "selection-required": return "selection-required"
        case "offline": return "offline"
        case "unsupported": return "unsupported"
        case "unavailable": return "unavailable"
        case "upstream-error": return "upstream-error"
        default: return assertNever(availability)
      }
    }

    expect([
      describeModelSelection({ status: "required", models: [{ providerId: "p", modelId: "m", name: "Model" }] }),
      describeModelSelection({ status: "optional" }),
      describeModelSelection({ status: "unsupported" }),
    ]).toEqual(["required", "optional", "unsupported"])
    expect([
      describeAvailability({ status: "available" }),
      describeAvailability({ status: "selection-required", selection: "harness" }),
      describeAvailability({ status: "offline", message: "workspace disconnected" }),
      describeAvailability({ status: "unsupported", operation: "fork" }),
      describeAvailability({ status: "unavailable", message: "connection stopped" }),
      describeAvailability({ status: "upstream-error", message: "remote failed" }),
    ]).toHaveLength(6)
  })

  test("keeps typed error and presentation event registries exhaustive", () => {
    const errors: AgentRuntimeError[] = [
      { code: "selection_required", message: "choose a harness", selection: "harness" },
      { code: "harness_unavailable", message: "not running", connectionId: "connection-1" },
      { code: "workspace_offline", message: "offline", workspaceId: "workspace-1" },
      { code: "unsupported_operation", message: "cannot fork", operation: "fork" },
      { code: "replay_gap", message: "cursor expired", cursor: "cursor-1" },
      { code: "upstream_error", message: "remote failed", connectionId: "connection-1" },
      { code: "invalid_execution_binding", message: "mismatch", field: "sessionId" },
    ]
    const events: AgentPresentationEvent[] = [
      { type: "message.completed", properties: { sessionID: "session-1", messageID: "message-1" } },
      { id: "session.idle:session-1", type: "session.idle", properties: { sessionID: "session-1" } },
      { type: "server.heartbeat", properties: {} },
    ]

    expect(new Set(AGENT_RUNTIME_ERROR_CODES)).toEqual(new Set(errors.map((error) => error.code)))
    expect(new Set(AGENT_PRESENTATION_EVENT_TYPES)).toContain("message.completed")
    expect(events.map((event) => event.type)).toEqual(["message.completed", "session.idle", "server.heartbeat"])
  })

  test("validates session, workspace, connection, and opaque upstream identity together", () => {
    const binding: AgentExecutionBinding = {
      sessionId: "session-1",
      workspaceId: "workspace-1",
      directory: "/work/one",
      connectionId: "connection-1",
      upstreamSessionId: "opaque-thread-1",
    }

    expect(assertAgentExecutionBinding(binding, binding)).toBe(binding)
    for (const field of ["sessionId", "workspaceId", "directory", "connectionId", "upstreamSessionId"] as const) {
      expect(() => assertAgentExecutionBinding(binding, { ...binding, [field]: `${binding[field]}-other` }))
        .toThrow(`execution binding ${field} mismatch`)
    }
    expect(() => assertAgentExecutionBinding({ ...binding, upstreamSessionId: "" })).toThrow("execution binding upstreamSessionId is required")
    expect(assertAgentExecutionBinding({ ...binding, directory: "" })).toEqual({ ...binding, directory: "" })
  })
})
