import { describe, expect, test } from "bun:test"
import {
  AGENT_PRESENTATION_EVENT_TYPES,
  AGENT_RUNTIME_ERROR_CODES,
  assertAgentExecutionBinding,
  requireAgentExecutionBinding,
  type AgentContentPart,
  type AgentExecutionBinding,
  type AgentFileContent,
  type AgentFilePartSource,
  type AgentPresentationMessage,
  type AgentPresentationEvent,
  type AgentReviewFileDiff,
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
        parts: [
          { id: "part-1", sessionID: binding.sessionId, messageID: "message-1", type: "text" as const, text: "hello" },
        ],
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
        case "required":
          return "required"
        case "optional":
          return "optional"
        case "unsupported":
          return "unsupported"
        default:
          return assertNever(selection)
      }
    }
    const describeAvailability = (availability: ExecutionAvailability) => {
      switch (availability.status) {
        case "available":
          return "available"
        case "selection-required":
          return "selection-required"
        case "offline":
          return "offline"
        case "unsupported":
          return "unsupported"
        case "unavailable":
          return "unavailable"
        case "upstream-error":
          return "upstream-error"
        default:
          return assertNever(availability)
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

  test("keeps presentation message and part discriminants exhaustive", () => {
    const role = (message: AgentPresentationMessage) => {
      switch (message.role) {
        case "user":
          return message.model?.modelID
        case "assistant":
          return message.modelID
        default:
          return assertNever(message)
      }
    }
    const partType = (part: AgentContentPart) => {
      switch (part.type) {
        case "text":
        case "reasoning":
        case "file":
        case "tool":
        case "subtask":
        case "step-start":
        case "step-finish":
        case "snapshot":
        case "patch":
        case "agent":
        case "retry":
        case "compaction":
        case "handoff":
          return part.type
        default:
          return assertNever(part)
      }
    }

    const messages: AgentPresentationMessage[] = [
      {
        id: "user-1",
        sessionID: "session-1",
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: "provider-1", modelID: "model-1" },
      },
      {
        id: "assistant-1",
        sessionID: "session-1",
        role: "assistant",
        time: { created: 2, completed: 3 },
        parentID: "user-1",
        modelID: "model-1",
        providerID: "provider-1",
        mode: "build",
        agent: "build",
        path: { cwd: "/work/one", root: "/work/one" },
        cost: 0,
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ]
    const parts: AgentContentPart[] = [
      { id: "p1", sessionID: "session-1", messageID: "user-1", type: "text", text: "hello" },
      {
        id: "p2",
        sessionID: "session-1",
        messageID: "assistant-1",
        type: "reasoning",
        text: "why",
        time: { start: 2 },
      },
      {
        id: "p3",
        sessionID: "session-1",
        messageID: "user-1",
        type: "file",
        mime: "text/plain",
        url: "file:///work/one/a.ts",
      },
      {
        id: "p4",
        sessionID: "session-1",
        messageID: "assistant-1",
        type: "tool",
        callID: "c1",
        tool: "read",
        state: { status: "pending", input: {}, raw: "{}" },
      },
      {
        id: "p5",
        sessionID: "session-1",
        messageID: "user-1",
        type: "subtask",
        prompt: "p",
        description: "d",
        agent: "build",
      },
      { id: "p6", sessionID: "session-1", messageID: "assistant-1", type: "step-start" },
      {
        id: "p7",
        sessionID: "session-1",
        messageID: "assistant-1",
        type: "step-finish",
        reason: "stop",
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      { id: "p8", sessionID: "session-1", messageID: "assistant-1", type: "snapshot", snapshot: "s1" },
      { id: "p9", sessionID: "session-1", messageID: "assistant-1", type: "patch", hash: "h1", files: ["a.ts"] },
      { id: "p10", sessionID: "session-1", messageID: "user-1", type: "agent", name: "review" },
      {
        id: "p11",
        sessionID: "session-1",
        messageID: "assistant-1",
        type: "retry",
        attempt: 1,
        error: { name: "APIError", data: { message: "retry" } },
        time: { created: 4 },
      },
      { id: "p12", sessionID: "session-1", messageID: "assistant-1", type: "compaction", auto: true },
      {
        id: "p13",
        sessionID: "session-1",
        messageID: "assistant-1",
        type: "handoff",
        from: { id: "a", access: "native" },
        to: { id: "b", access: "native" },
      },
    ]

    expect(messages.map(role)).toEqual(["model-1", "model-1"])
    expect(parts.map(partType)).toHaveLength(13)
  })

  test("round trips file source, media, and review presentation shapes", () => {
    const source: AgentFilePartSource = {
      type: "symbol",
      text: { value: "@run", start: 0, end: 4 },
      path: "/work/one/run.ts",
      range: { start: { line: 1, character: 0 }, end: { line: 2, character: 1 } },
      name: "run",
      kind: 12,
    }
    const content: AgentFileContent = {
      type: "binary",
      content: "aGVsbG8=",
      encoding: "base64",
      mimeType: "image/png",
    }
    const review: AgentReviewFileDiff = {
      file: "run.ts",
      before: "export const run = 1\n",
      after: "export const run = 2\n",
      additions: 1,
      deletions: 1,
      status: "modified",
    }

    expect(jsonRoundTrip({ source, content, review })).toEqual({ source, content, review })
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
      expect(() => assertAgentExecutionBinding(binding, { ...binding, [field]: `${binding[field]}-other` })).toThrow(
        `execution binding ${field} mismatch`,
      )
    }
    expect(() => requireAgentExecutionBinding({ ...binding, upstreamSessionId: "" })).toThrow(
      "execution binding upstreamSessionId is required",
    )
    expect(() => requireAgentExecutionBinding({ ...binding, directory: "" })).toThrow("execution binding directory is required")
  })

  test("rejects removed scopes and missing machine identity", () => {
    const binding = { scope: "workspace" as const, sessionId: "session-1", workspaceId: "ws-1", directory: "/repo", connectionId: "native:pi", upstreamSessionId: "pi-1" }
    expect(requireAgentExecutionBinding(binding)).toBe(binding)
    expect(() => requireAgentExecutionBinding({ ...binding, scope: "central" } as unknown as AgentExecutionBinding)).toThrow("workspace execution scope is required")
    expect(() => requireAgentExecutionBinding({ ...binding, workspaceId: "" })).toThrow("workspaceId is required")
  })
})
