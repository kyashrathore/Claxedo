import { describe, expect, test } from "bun:test"
import { claudeSubagentObservations } from "./subagent-observations"
import { claudeChildCorrelationKey } from "./subagent-routing"
import { createClaudeTaskLedger } from "./task-ledger"
import { claudeRuntime as runtime } from "../test-support/runtime"

function parentAgentCall(toolCallId: string) {
  return {
    type: "assistant",
    uuid: `call-${toolCallId}`,
    session_id: "sdk-session-1",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", id: toolCallId, name: "Agent", input: { description: "Find the project name", subagent_type: "general-purpose" } }] },
  }
}

describe("claudeSdkAdapter", () => {
  test("U5: registers complete child-owned tool blocks for child transcript routing", () => {
    const payload = {
      type: "assistant",
      uuid: "assistant-child-1",
      session_id: "sdk-session-1",
      parent_tool_use_id: "tool-agent-parent-1",
      message: {
        content: [{ type: "tool_use", id: "tool-read-child-1", name: "Read", input: { file_path: "src/a.ts" } }],
      },
    }

    expect(claudeChildCorrelationKey(payload)).toBe("tool-agent-parent-1")
    expect(runtime().ingest({ source: "claude.sdk.message", payload }).events).toMatchObject([
      { type: "tool-start", toolCallId: "tool-read-child-1", toolName: "Read" },
      { type: "tool-input", toolCallId: "tool-read-child-1", input: { file_path: "src/a.ts" } },
    ])
  })

  test("U5: normalizes Claude task lifecycle without requiring a tool use id", () => {
    const ledger = createClaudeTaskLedger()
    expect(claudeSubagentObservations({
      type: "system",
      subtype: "task_started",
      uuid: "task-start-1",
      session_id: "sdk-session-1",
      task_id: "task-1",
      description: "Ambient review",
      subagent_type: "code-reviewer",
    }, ledger)).toEqual([{
      observationId: "claude:task_started:task-start-1",
      harnessExecutionId: "sdk-session-1",
      stableCorrelationId: "task-1",
      status: "running",
      label: "Ambient review",
      description: "Ambient review",
      subagentType: "code-reviewer",
      providerKind: "claude-agent",
      transcript: { kind: "messages" },
    }])

    expect(claudeSubagentObservations({
      type: "system",
      subtype: "task_updated",
      uuid: "task-update-1",
      session_id: "sdk-session-1",
      task_id: "task-1",
      patch: { status: "paused", is_backgrounded: true },
    }, ledger)).toEqual([{
      observationId: "claude:task_updated:task-update-1",
      harnessExecutionId: "sdk-session-1",
      stableCorrelationId: "task-1",
      mode: "background",
      status: "paused",
      providerKind: "claude-agent",
      transcript: { kind: "messages" },
    }])

    expect(claudeSubagentObservations({
      type: "system",
      subtype: "task_updated",
      uuid: "task-update-2",
      session_id: "sdk-session-1",
      task_id: "task-1",
      patch: { end_time: 17, total_paused_ms: 4 },
    }, ledger)).toEqual([])

    expect(claudeSubagentObservations({
      type: "system",
      subtype: "task_notification",
      uuid: "task-done-1",
      session_id: "sdk-session-1",
      task_id: "task-1",
      status: "stopped",
      summary: "Stopped",
    }, ledger)[0]).toMatchObject({ stableCorrelationId: "task-1", status: "killed" })
  })

  test("U5: background_tasks_changed is a level signal and spawns no subagent row", () => {
    const ledger = createClaudeTaskLedger()
    expect(claudeSubagentObservations({
      type: "system",
      subtype: "background_tasks_changed",
      uuid: "background-1",
      session_id: "sdk-session-1",
      tasks: [{ task_id: "task-1", task_type: "local_bash", description: "npm run build" }],
    }, ledger)).toEqual([])
    expect(claudeSubagentObservations({
      type: "system",
      subtype: "background_tasks_changed",
      uuid: "background-2",
      session_id: "sdk-session-1",
      tasks: [],
    }, ledger)).toEqual([])
  })

  test("U5: a background subagent dropped from the live set gets the terminal it was never sent", () => {
    const ledger = createClaudeTaskLedger()
    claudeSubagentObservations(parentAgentCall("tool-agent-1"), ledger)
    claudeSubagentObservations({
      type: "system",
      subtype: "task_started",
      uuid: "task-start-agent",
      session_id: "sdk-session-1",
      task_id: "task-agent",
      tool_use_id: "tool-agent-1",
      description: "Review auth",
      subagent_type: "code-reviewer",
    }, ledger)
    claudeSubagentObservations({
      type: "system",
      subtype: "task_started",
      uuid: "task-start-bash",
      session_id: "sdk-session-1",
      task_id: "task-bash",
      task_type: "local_bash",
      description: "npm run build",
    }, ledger)
    const live = (uuid: string, tasks: Array<{ task_id: string; task_type: string; description: string }>) => claudeSubagentObservations({
      type: "system",
      subtype: "background_tasks_changed",
      uuid,
      session_id: "sdk-session-1",
      tasks,
    }, ledger)

    expect(live("background-1", [
      { task_id: "task-agent", task_type: "local_agent", description: "Review auth" },
      { task_id: "task-bash", task_type: "local_bash", description: "npm run build" },
    ])).toEqual([])

    expect(live("background-2", [{ task_id: "task-bash", task_type: "local_bash", description: "npm run build" }])).toEqual([{
      observationId: "claude:background_tasks_changed:background-2:task-agent",
      harnessExecutionId: "sdk-session-1",
      stableCorrelationId: "task-agent",
      toolCallId: "tool-agent-1",
      toolCallRole: "spawn",
      status: "interrupted",
      providerKind: "claude-agent",
      transcript: { kind: "messages" },
    }])

    expect(live("background-3", [])).toEqual([])
  })

  test("U5: only a Task subagent's own lifecycle becomes a subagent row", () => {
    const ledger = createClaudeTaskLedger()
    expect(claudeSubagentObservations({
      type: "system",
      subtype: "task_started",
      uuid: "task-start-bash",
      session_id: "sdk-session-1",
      task_id: "task-bash",
      tool_use_id: "bash-1",
      task_type: "local_bash",
      description: "npm run build",
    }, ledger)).toEqual([])

    expect(claudeSubagentObservations({
      type: "system",
      subtype: "task_started",
      uuid: "task-start-ambient",
      session_id: "sdk-session-1",
      task_id: "task-ambient",
      description: "Summarize the session",
      subagent_type: "housekeeping",
      skip_transcript: true,
    }, ledger)).toEqual([])

    expect(claudeSubagentObservations({
      type: "system",
      subtype: "task_notification",
      uuid: "task-done-ambient",
      session_id: "sdk-session-1",
      task_id: "task-ambient",
      status: "completed",
      summary: "Summarized",
    }, ledger)).toEqual([])

    expect(claudeSubagentObservations({
      type: "system",
      subtype: "task_notification",
      uuid: "task-done-bash",
      session_id: "sdk-session-1",
      task_id: "task-bash",
      tool_use_id: "bash-1",
      status: "completed",
      summary: "npm run build finished",
    }, ledger)).toEqual([])

    expect(claudeSubagentObservations({
      type: "system",
      subtype: "task_notification",
      uuid: "task-done-unknown",
      session_id: "sdk-session-1",
      task_id: "task-never-introduced",
      status: "completed",
      summary: "Something finished",
    }, ledger)).toEqual([])

    expect(claudeSubagentObservations({
      type: "system",
      subtype: "task_progress",
      uuid: "task-progress-bash",
      session_id: "sdk-session-1",
      task_id: "task-bash",
      tool_use_id: "bash-1",
      description: "npm run build",
      usage: { total_tokens: 0, tool_uses: 0, duration_ms: 10 },
    }, ledger)).toEqual([])
  })

  test("U5: a user message batching several tool results cannot attribute its single agent result", () => {
    expect(claudeSubagentObservations({
      type: "user",
      uuid: "batched-agent-results",
      session_id: "sdk-session-1",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tool-agent-1", content: "first report" },
          { type: "tool_result", tool_use_id: "tool-agent-2", content: "second report" },
        ],
      },
      tool_use_result: { status: "completed", agentId: "agent-42", content: [{ type: "text", text: "first report" }] },
    }, createClaudeTaskLedger())).toEqual([])

    const ledger = createClaudeTaskLedger()
    claudeSubagentObservations(parentAgentCall("tool-agent-1"), ledger)
    expect(claudeSubagentObservations({
      type: "user",
      uuid: "single-agent-result",
      session_id: "sdk-session-1",
      parent_tool_use_id: null,
      message: {
        content: [{ type: "tool_result", tool_use_id: "tool-agent-1", content: "first report" }],
      },
      tool_use_result: { status: "completed", agentId: "agent-42", content: [{ type: "text", text: "first report" }] },
    }, ledger)).toEqual([{
      observationId: "claude:agent-result:single-agent-result:tool-agent-1",
      harnessExecutionId: "sdk-session-1",
      toolCallId: "tool-agent-1",
      toolCallRole: "spawn",
      status: "completed",
      providerId: "agent-42",
      providerKind: "claude-agent",
      transcript: { kind: "messages" },
    }])
  })

  test("U5: every frame of a Task call the parent made names that call as the subagent's spawn", () => {
    const ledger = createClaudeTaskLedger()
    const edges = [
      parentAgentCall("toolu_1"),
      { type: "system", subtype: "task_started", uuid: "started", session_id: "sdk-session-1", task_id: "task-1", tool_use_id: "toolu_1", description: "Find the project name", subagent_type: "general-purpose", spawn_depth: 1 },
      { type: "system", subtype: "task_notification", uuid: "notified", session_id: "sdk-session-1", task_id: "task-1", tool_use_id: "toolu_1", status: "completed", summary: "Found it" },
      {
        type: "user",
        uuid: "result",
        session_id: "sdk-session-1",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Found it" }] },
        tool_use_result: { status: "completed", agentId: "agent-1", content: [{ type: "text", text: "Found it" }] },
      },
    ].flatMap((frame) => claudeSubagentObservations(frame, ledger).map(({ toolCallId, toolCallRole }) => ({ toolCallId, toolCallRole })))

    expect(edges).toEqual(Array(4).fill({ toolCallId: "toolu_1", toolCallRole: "spawn" }))
  })

  for (const shape of ["finishes before the turn's result", "outlives the turn's result"] as const) {
    test(`U5: every frame of a background Task call the parent made names that call as the spawn when the child ${shape}`, () => {
      const ledger = createClaudeTaskLedger()
      const frame = (subtype: string, uuid: string, fields: Record<string, unknown>) => ({ type: "system", subtype, uuid, session_id: "sdk-session-1", ...fields })
      const parentText = { type: "assistant", uuid: "parent-text", session_id: "sdk-session-1", parent_tool_use_id: null, message: { content: [{ type: "text", text: "DONE" }] } }
      const result = { type: "result", subtype: "success", uuid: "result", session_id: "sdk-session-1" }
      const child = [
        { type: "assistant", uuid: "child-text", session_id: "sdk-session-1", parent_tool_use_id: "toolu_1", message: { content: [{ type: "text", text: "ok" }] } },
        frame("background_tasks_changed", "departed", { tasks: [] }),
        frame("task_updated", "updated", { task_id: "task-1", patch: { status: "completed" } }),
        frame("task_notification", "notified", { task_id: "task-1", tool_use_id: "toolu_1", status: "completed", summary: "ok" }),
      ]
      const frames = [
        { ...parentAgentCall("toolu_1"), message: { content: [{ type: "tool_use", id: "toolu_1", name: "Agent", input: { description: "Find the project name", subagent_type: "general-purpose", run_in_background: true } }] } },
        frame("background_tasks_changed", "live", { tasks: [{ task_id: "task-1", task_type: "local_agent", description: "Find the project name" }] }),
        frame("task_started", "started", { task_id: "task-1", tool_use_id: "toolu_1", description: "Find the project name", subagent_type: "general-purpose", is_backgrounded: true, spawn_depth: 1 }),
        {
          type: "user",
          uuid: "launched",
          session_id: "sdk-session-1",
          parent_tool_use_id: null,
          message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "Async agent launched successfully." }] }] },
          tool_use_result: { isAsync: true, status: "async_launched", agentId: "task-1", description: "Find the project name" },
        },
        ...(shape === "outlives the turn's result" ? [parentText, result, ...child] : [...child, parentText, result]),
      ]
      const edges = frames.flatMap((item) => claudeSubagentObservations(item, ledger).map(({ stableCorrelationId, toolCallId, toolCallRole }) => (toolCallId ? { toolCallId, toolCallRole } : { stableCorrelationId })))
      const spawn = { toolCallId: "toolu_1", toolCallRole: "spawn" as const }

      expect(edges, "the call, task_started, the async launch, the departure, task_updated by its task id alone, task_notification").toEqual([spawn, spawn, spawn, spawn, { stableCorrelationId: "task-1" }, spawn])
    })
  }

  test("U5: a subagent a skill's forked execution runs keeps its call for routing but has no spawn edge", () => {
    const ledger = createClaudeTaskLedger()
    claudeSubagentObservations({
      type: "assistant",
      uuid: "skill-call",
      session_id: "sdk-session-1",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "toolu_skill", name: "Skill", input: { skill: "review-lanes" } }] },
    }, ledger)
    const forkResult = claudeSubagentObservations({
      type: "user",
      uuid: "skill-result",
      session_id: "sdk-session-1",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_skill", content: "Skill completed (forked execution)." }] },
      tool_use_result: { status: "forked", agentId: "agent-fork", content: [{ type: "text", text: "done" }] },
    }, ledger)
    const lane = [
      { type: "system", subtype: "task_started", uuid: "lane-started", session_id: "sdk-session-1", task_id: "task-lane", tool_use_id: "toolu_forked_agent", description: "Review lane one", subagent_type: "general-purpose" },
      { type: "system", subtype: "task_notification", uuid: "lane-notified", session_id: "sdk-session-1", task_id: "task-lane", tool_use_id: "toolu_forked_agent", status: "completed", summary: "Reviewed" },
    ].flatMap((frame) => claudeSubagentObservations(frame, ledger))

    expect(forkResult).toEqual([{
      observationId: "claude:agent-result:skill-result:toolu_skill",
      harnessExecutionId: "sdk-session-1",
      toolCallId: "toolu_skill",
      status: "completed",
      providerId: "agent-fork",
      providerKind: "claude-agent",
      transcript: { kind: "messages" },
    }])
    expect(lane.map(({ stableCorrelationId, toolCallId, toolCallRole }) => ({ stableCorrelationId, toolCallId, toolCallRole }))).toEqual(
      Array(2).fill({ stableCorrelationId: "task-lane", toolCallId: "toolu_forked_agent", toolCallRole: undefined }),
    )
  })

  test("binds a create_subagent result to the host-minted child and classifies the call as task work", () => {
    const agent = runtime()
    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-mcp-spawn-1",
            name: "mcp__claxedo__create_subagent",
            input: { harness: "codex", prompt: "Consult on the plan" },
          },
        },
      },
    }).events).toMatchObject([
      { type: "tool-start", toolCallId: "tool-mcp-spawn-1", kind: "collab_agent_tool_call", display: { intent: "task" } },
      { type: "tool-input", toolCallId: "tool-mcp-spawn-1" },
    ])

    const ledger = createClaudeTaskLedger()
    expect(claudeSubagentObservations(toolCallFrame("tool-mcp-spawn-1", "mcp__claxedo__create_subagent"), ledger)).toEqual([])

    const binding = JSON.stringify({ kind: "claxedo.subagent", subagentKey: "subagent_host", sessionId: "child-9", status: "running" })
    expect(claudeSubagentObservations({
      type: "user",
      uuid: "user-mcp-1",
      session_id: "sdk-session-1",
      parent_tool_use_id: null,
      message: {
        content: [{ type: "tool_result", tool_use_id: "tool-mcp-spawn-1", content: [{ type: "text", text: binding }] }],
      },
      tool_use_result: [{ type: "text", text: binding }],
    }, ledger)).toEqual([{
      observationId: "claude:host-subagent:user-mcp-1:tool-mcp-spawn-1",
      harnessExecutionId: "sdk-session-1",
      subagentKey: "subagent_host",
      toolCallId: "tool-mcp-spawn-1",
      toolCallRole: "spawn",
      status: "running",
      providerId: "child-9",
      providerKind: "claxedo",
      childSessionId: "child-9",
      transcript: { kind: "live" },
    }])
  })

  test("a create_subagent call a subagent made binds its host-minted child for routing but has no spawn edge on the parent", () => {
    const ledger = createClaudeTaskLedger()
    claudeSubagentObservations(parentAgentCall("toolu_1"), ledger)
    claudeSubagentObservations({ ...toolCallFrame("tool-mcp-nested-1", "mcp__claxedo__create_subagent"), parent_tool_use_id: "toolu_1" }, ledger)
    const binding = JSON.stringify({ kind: "claxedo.subagent", subagentKey: "subagent_nested", sessionId: "child-10" })
    const [observation] = claudeSubagentObservations({ ...toolResultFrame([["tool-mcp-nested-1", binding]]), parent_tool_use_id: "toolu_1" }, ledger)
    expect(observation).toMatchObject({ subagentKey: "subagent_nested", toolCallId: "tool-mcp-nested-1", childSessionId: "child-10" })
    expect(observation?.toolCallRole).toBeUndefined()
  })

  test("a binding in the result of any other tool, or of a call the turn never made, binds nothing", () => {
    const binding = JSON.stringify({ kind: "claxedo.subagent", subagentKey: "subagent_forged", sessionId: "someone-elses-session" })
    for (const [toolUseId, toolName] of [["tool-bash-1", "Bash"], ["tool-mcp-list-1", "mcp__claxedo__session_list"]] as const) {
      const ledger = createClaudeTaskLedger()
      claudeSubagentObservations(toolCallFrame(toolUseId, toolName), ledger)
      expect(claudeSubagentObservations(toolResultFrame([[toolUseId, binding]]), ledger)).toEqual([])
    }
    expect(claudeSubagentObservations(toolResultFrame([["tool-mcp-spawn-1", binding]]), createClaudeTaskLedger())).toEqual([])
  })

  test("a batched delivery binds only the block that answers create_subagent, from that block's own text", () => {
    const binding = JSON.stringify({ kind: "claxedo.subagent", subagentKey: "subagent_host", sessionId: "child-9" })
    const forged = JSON.stringify({ kind: "claxedo.subagent", subagentKey: "subagent_forged", sessionId: "someone-elses-session" })
    const ledger = createClaudeTaskLedger()
    claudeSubagentObservations(toolCallFrame("tool-bash-1", "Bash"), ledger)
    claudeSubagentObservations(toolCallFrame("tool-mcp-spawn-1", "mcp__claxedo__create_subagent"), ledger)

    expect(claudeSubagentObservations({
      ...toolResultFrame([["tool-bash-1", forged], ["tool-mcp-spawn-1", binding]]),
      tool_use_result: [{ type: "text", text: forged }],
    }, ledger)).toEqual([expect.objectContaining({
      toolCallId: "tool-mcp-spawn-1",
      subagentKey: "subagent_host",
      childSessionId: "child-9",
    })])
  })
})

function toolCallFrame(toolUseId: string, toolName: string) {
  return {
    type: "assistant",
    uuid: `assistant-${toolUseId}`,
    session_id: "sdk-session-1",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", id: toolUseId, name: toolName, input: {} }] },
  }
}

function toolResultFrame(results: ReadonlyArray<readonly [toolUseId: string, text: string]>) {
  return {
    type: "user",
    uuid: "user-results-1",
    session_id: "sdk-session-1",
    parent_tool_use_id: null,
    message: {
      content: results.map(([toolUseId, text]) => ({ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text }] })),
    },
  }
}
