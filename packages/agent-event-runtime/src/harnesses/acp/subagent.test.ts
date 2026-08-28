import { describe, expect, test } from "bun:test"
import { acpCodexCollaborationStates, classifyAcpSubagentUpdate } from "./subagent"

describe("classifyAcpSubagentUpdate", () => {
  test("recognizes Claude lifecycle metadata and its message transcript", () => {
    expect(classifyAcpSubagentUpdate("claude-acp", {
      sessionUpdate: "tool_call",
      toolCallId: "agent-1",
      title: "Agent",
      status: "in_progress",
      rawInput: { description: "Inspect cache", subagentType: "Explore" },
      _meta: { claudeCode: { subagent: true } },
    })).toEqual({
      kind: "lifecycle",
      correlationKey: "agent-1",
      observation: {
        observationId: "agent-1:tool_call:in_progress:running",
        stableCorrelationId: "agent-1",
        toolCallId: "agent-1",
        toolCallRole: "spawn",
        mode: "foreground",
        status: "running",
        label: "Agent",
        subagentType: "Explore",
        description: "Inspect cache",
        transcript: { kind: "messages", ref: "acp:agent-1" },
      },
    })
  })

  test("routes every Claude nested update through its parent tool use", () => {
    const updates = [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "child" } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
      { sessionUpdate: "tool_call", toolCallId: "nested-tool", title: "Read" },
    ] as const

    for (const update of updates) {
      expect(classifyAcpSubagentUpdate("claude-acp", {
        ...update,
        _meta: { claudeCode: { parentToolUseId: "agent-1" } },
      } as Parameters<typeof classifyAcpSubagentUpdate>[1])).toEqual({
        kind: "child",
        correlationKey: "agent-1",
      })
    }
  })

  test("recognizes Claude Task updates when the ACP wrapper omits subagent metadata", () => {
    const started = classifyAcpSubagentUpdate("claude-acp", {
      sessionUpdate: "tool_call",
      toolCallId: "agent-2",
      title: "Task Verify ACP child delegation",
      status: "pending",
      rawInput: {
        description: "Verify ACP child delegation",
        prompt: "Reply with exactly CHILD-CLAUDE-ACP",
        subagent_type: "general-purpose",
      },
    })
    expect(started).toMatchObject({
      kind: "lifecycle",
      observation: {
        toolCallRole: "spawn",
        status: "pending",
        transcript: { kind: "messages", ref: "acp:agent-2" },
      },
    })

    expect(classifyAcpSubagentUpdate("claude-acp", {
      sessionUpdate: "tool_call_update",
      toolCallId: "agent-2",
      status: "completed",
    }, started?.kind === "lifecycle" ? started.observation : undefined)).toMatchObject({
      kind: "lifecycle",
      observation: { status: "completed" },
    })
  })

  test("models Codex Start, Interact, and Interrupt as registry lifecycle updates", () => {
    const cases = [
      ["Start subagent worker", "started", "spawn", "running"],
      ["Interact with subagent worker", "interacted", "interaction", "running"],
      ["Interrupt subagent worker", "interrupted", "interaction", "interrupted"],
    ] as const

    for (const [title, activity, role, status] of cases) {
      expect(classifyAcpSubagentUpdate("codex-acp", {
        sessionUpdate: "tool_call_update",
        toolCallId: `activity-${activity}`,
        title,
        status: "completed",
        rawInput: { agentThreadId: "thread-1", activityKind: activity },
        _meta: { codex: { subagent: { threadId: "thread-1", activity } } },
      })).toMatchObject({
        kind: "lifecycle",
        observation: {
          toolCallRole: role,
          status,
          providerId: "thread-1",
          providerKind: "codex-acp-thread",
          transcript: { kind: "none" },
        },
      })
    }
  })

  test("does not confuse completion of a Codex activity item with completion of its child", () => {
    const started = classifyAcpSubagentUpdate("codex-acp", {
      sessionUpdate: "tool_call",
      toolCallId: "activity-started",
      title: "Start subagent worker",
      status: "in_progress",
      rawInput: { agentThreadId: "thread-1", activityKind: "started" },
      _meta: { codex: { subagent: { threadId: "thread-1", activity: "started" } } },
    })

    expect(classifyAcpSubagentUpdate("codex-acp", {
      sessionUpdate: "tool_call_update",
      toolCallId: "activity-started",
      status: "completed",
      rawInput: { agentThreadId: "thread-1", activityKind: "started" },
      _meta: { codex: { subagent: { threadId: "thread-1", activity: "started" } } },
    }, started?.kind === "lifecycle" ? started.observation : undefined)).toMatchObject({
      kind: "lifecycle",
      observation: { status: "running" },
    })
  })

  test("reads terminal child state from the canonical Codex collaboration snapshot", () => {
    expect(acpCodexCollaborationStates("codex-acp", {
      sessionUpdate: "tool_call_update",
      toolCallId: "wait-1",
      title: "wait",
      status: "completed",
      rawInput: {
        receiverThreadIds: ["thread-1", "thread-2"],
        agentsStates: {
          "thread-1": { status: "completed", message: null },
          "thread-2": { status: "errored", message: "failed" },
        },
      },
      _meta: { codex: { collaboration: { tool: "wait" } } },
    })).toEqual([
      { providerId: "thread-1", status: "completed", observationId: "wait-1:collaboration:thread-1:completed" },
      { providerId: "thread-2", status: "failed", observationId: "wait-1:collaboration:thread-2:failed" },
    ])
  })

  test("recognizes Cursor tasks without fabricating a transcript", () => {
    expect(classifyAcpSubagentUpdate("cursor-acp", {
      sessionUpdate: "tool_call",
      toolCallId: "task-1",
      title: "Task: Subagent task",
      rawInput: { description: "Inspect cache" },
    })).toMatchObject({
      kind: "lifecycle",
      observation: {
        toolCallRole: "spawn",
        description: "Inspect cache",
        transcript: { kind: "none" },
      },
    })
  })
})
