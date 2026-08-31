import { describe, expect, test } from "bun:test"
import {
  AGENT_RUNTIME_EVENT_FACTORY_TYPES,
  AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
  AGENT_RUNTIME_EVENT_TYPES,
  agentRuntimeEvent,
  isRuntimeGoalStatus,
} from "./agent-runtime-event"

describe("AgentRuntimeEvent contract", () => {
  test("exposes an explicit contract version and event kind registry", () => {
    expect(AGENT_RUNTIME_EVENT_CONTRACT_VERSION).toBe(7)
    expect(AGENT_RUNTIME_EVENT_TYPES).toContain("text-delta")
    expect(AGENT_RUNTIME_EVENT_TYPES).toContain("user-message-delta")
    expect(AGENT_RUNTIME_EVENT_TYPES).toContain("tool-status")
    expect(AGENT_RUNTIME_EVENT_TYPES).toContain("tool-content")
    expect(AGENT_RUNTIME_EVENT_TYPES).toContain("tool-output")
    expect(AGENT_RUNTIME_EVENT_TYPES).toContain("thinking-audio-delta")
    expect(AGENT_RUNTIME_EVENT_TYPES).toContain("thinking-resource-link-delta")
    expect(AGENT_RUNTIME_EVENT_TYPES).toContain("resource-delta")
    expect(AGENT_RUNTIME_EVENT_TYPES).toContain("available-commands-update")
    expect(AGENT_RUNTIME_EVENT_TYPES).toContain("session-info")
    expect(AGENT_RUNTIME_EVENT_TYPES).toContain("session-compaction")
    expect(AGENT_RUNTIME_EVENT_TYPES).toContain("harness-notice")
    expect(AGENT_RUNTIME_EVENT_TYPES).toContain("auth-status")
    expect(AGENT_RUNTIME_EVENT_TYPES).toContain("rate-limit")
    expect(AGENT_RUNTIME_EVENT_TYPES).toContain("mcp-server-status")
    expect(AGENT_RUNTIME_EVENT_TYPES).toContain("subagent-updated")
    expect(AGENT_RUNTIME_EVENT_TYPES).toContain("goal-updated")
    expect(AGENT_RUNTIME_EVENT_TYPES).toContain("goal-cleared")
    expect(AGENT_RUNTIME_EVENT_TYPES).toContain("diagnostic")
    expect(new Set(AGENT_RUNTIME_EVENT_TYPES).size).toBe(AGENT_RUNTIME_EVENT_TYPES.length)
    expect(Object.values(AGENT_RUNTIME_EVENT_FACTORY_TYPES).sort()).toEqual([...AGENT_RUNTIME_EVENT_TYPES].sort())
  })

  test("recognizes only normalized Goal statuses", () => {
    for (const status of ["active", "paused", "blocked", "limited", "complete"] as const) {
      expect(isRuntimeGoalStatus(status)).toBe(true)
    }
    expect(isRuntimeGoalStatus("usageLimited")).toBe(false)
    expect(isRuntimeGoalStatus("budgetLimited")).toBe(false)
    expect(isRuntimeGoalStatus("done")).toBe(false)
  })

  test("constructs representative events through typed factories", () => {
    expect(agentRuntimeEvent.textDelta({ delta: "hello" })).toEqual({
      type: "text-delta",
      delta: "hello",
    })
    expect(agentRuntimeEvent.toolOutput({
      toolCallId: "tool-1",
      output: { stdout: "ok" },
      metadata: { harness: "test" },
    })).toEqual({
      type: "tool-output",
      toolCallId: "tool-1",
      output: { stdout: "ok" },
      metadata: { harness: "test" },
    })
    expect(agentRuntimeEvent.diagnostic({
      harness: "provider-1",
      threadId: "thread-1",
      diagnostic: {
        code: "runtime.adapter_error",
        message: "boom",
        severity: "error",
      },
    })).toEqual({
      type: "diagnostic",
      harness: "provider-1",
      threadId: "thread-1",
      diagnostic: {
        code: "runtime.adapter_error",
        message: "boom",
        severity: "error",
      },
    })
    expect(agentRuntimeEvent.subagentUpdated({
      subagentKey: "subagent-1",
      revision: 3,
      toolCallId: "call-1",
      toolCallRole: "spawn",
      childSessionId: "session-child-1",
      transcript: { kind: "live", ref: "transcript-1" },
    })).toEqual({
      type: "subagent-updated",
      subagentKey: "subagent-1",
      revision: 3,
      toolCallId: "call-1",
      toolCallRole: "spawn",
      childSessionId: "session-child-1",
      transcript: { kind: "live", ref: "transcript-1" },
    })
    expect(agentRuntimeEvent.goalUpdated({
      sessionId: "session-1",
      goal: {
        sessionId: "session-1",
        objective: "Ship when verification passes",
        status: "active",
        createdAt: 1,
        updatedAt: 2,
        tokenBudget: 10_000,
      },
    })).toEqual({
      type: "goal-updated",
      sessionId: "session-1",
      goal: {
        sessionId: "session-1",
        objective: "Ship when verification passes",
        status: "active",
        createdAt: 1,
        updatedAt: 2,
        tokenBudget: 10_000,
      },
    })
    expect(agentRuntimeEvent.goalCleared({ sessionId: "session-1" })).toEqual({
      type: "goal-cleared",
      sessionId: "session-1",
    })
  })

  test("constructs ACP-rich events through typed factories", () => {
    expect(agentRuntimeEvent.userMessageDelta({
      messageId: "message-1",
      content: { type: "text", text: "hello" },
    })).toEqual({
      type: "user-message-delta",
      messageId: "message-1",
      content: { type: "text", text: "hello" },
    })
    expect(agentRuntimeEvent.availableCommandsUpdate({
      commands: [{ name: "create_plan", description: "Create a plan" }],
    })).toEqual({
      type: "available-commands-update",
      commands: [{ name: "create_plan", description: "Create a plan" }],
    })
    expect(agentRuntimeEvent.sessionInfo({ title: null, updatedAt: "2026-06-16T00:00:00.000Z", parentID: "parent-1" })).toEqual({
      type: "session-info",
      title: null,
      updatedAt: "2026-06-16T00:00:00.000Z",
      parentID: "parent-1",
    })
    expect(agentRuntimeEvent.toolStatus({ toolCallId: "tool-1", status: "pending" })).toEqual({
      type: "tool-status",
      toolCallId: "tool-1",
      status: "pending",
    })
    expect(agentRuntimeEvent.sessionCompaction({ phase: "completed" })).toEqual({
      type: "session-compaction",
      phase: "completed",
    })
    expect(agentRuntimeEvent.harnessNotice({ code: "provider.warning", message: "Heads up" })).toEqual({
      type: "harness-notice",
      code: "provider.warning",
      message: "Heads up",
    })
    expect(agentRuntimeEvent.toolContent({
      toolCallId: "tool-1",
      content: { type: "content", content: { type: "text", text: "result" } },
    })).toEqual({
      type: "tool-content",
      toolCallId: "tool-1",
      content: { type: "content", content: { type: "text", text: "result" } },
    })
    expect(agentRuntimeEvent.thinkingAudioDelta({ mimeType: "audio/wav", data: "AAAA" })).toEqual({
      type: "thinking-audio-delta",
      mimeType: "audio/wav",
      data: "AAAA",
    })
    expect(agentRuntimeEvent.thinkingResourceLinkDelta({ uri: "file:///tmp/a", name: "a" })).toEqual({
      type: "thinking-resource-link-delta",
      uri: "file:///tmp/a",
      name: "a",
    })
    expect(agentRuntimeEvent.resourceDelta({
      channel: "assistant",
      resource: { uri: "file:///tmp/a", blob: "AAAA" },
    })).toEqual({
      type: "resource-delta",
      channel: "assistant",
      resource: { uri: "file:///tmp/a", blob: "AAAA" },
    })
  })
})
