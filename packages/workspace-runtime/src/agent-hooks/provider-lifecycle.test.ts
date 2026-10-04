import { lifecycle } from "../test-support/status-hooks"
import { describe, expect, test } from "bun:test"

describe("provider lifecycle normalization", () => {
  test("native interruption settles as cancellation without a success outcome", () => {
    expect(lifecycle({ hook_event_name: "Interrupt", session_id: "codex-main", turn_id: "turn-1" })).toMatchObject({
      eventType: "Idle", outcome: "cancelled", sessionId: "codex-main",
    })
  })

  test("Antigravity settles only an idle execution, never an individual model invocation", () => {
    const input = { provider: "antigravity", event: { conversationId: "agy-main", transcriptPath: "/tmp/transcript.jsonl" } }
    expect(lifecycle({ ...input, hook_event_name: "PreInvocation" })).toMatchObject({ eventType: "Busy", sessionId: "agy-main" })
    expect(lifecycle({ ...input, hook_event_name: "PostInvocation" })).toBeUndefined()
    const stop = { ...input, hook_event_name: "Stop" }
    expect(lifecycle({ ...stop, event: { ...input.event, fullyIdle: false, terminationReason: "model_stop" } })).toBeUndefined()
    expect(lifecycle({ ...stop, event: { ...input.event, terminationReason: "model_stop" } })).toBeUndefined()
    expect(lifecycle({ ...stop, event: { ...input.event, fullyIdle: true, terminationReason: "model_stop" } })).toMatchObject({ eventType: "Idle", outcome: "done", sessionId: "agy-main" })
    expect(lifecycle({ ...stop, event: { ...input.event, fullyIdle: true, terminationReason: "error" } })).toMatchObject({ eventType: "Error", outcome: "error" })
    expect(lifecycle({ ...stop, event: { ...input.event, fullyIdle: true, terminationReason: "unknown" } })).toBeUndefined()
  })
  test("Amp preserves thread identity and distinguishes completed, failed and cancelled turns", () => {
    const event = { thread: { id: "T-amp" }, id: "M-1", message: "hello" }
    expect(lifecycle({ provider: "amp", hook_event_name: "agent.start", event })).toMatchObject({ provider: "amp", sessionId: "T-amp", eventType: "Busy" })
    for (const outcome of ["done", "error", "cancelled"] as const) {
      expect(lifecycle({ provider: "amp", hook_event_name: "agent.end", event: { ...event, status: outcome } })).toMatchObject({
        eventType: outcome === "error" ? "Error" : "Idle", outcome, sessionId: "T-amp",
      })
    }
    expect(lifecycle({ provider: "amp", hook_event_name: "agent.end", event })).toBeUndefined()
    expect(lifecycle({ provider: "amp", hook_event_name: "tool.result", event: { ...event, status: "done" } })).toBeUndefined()
  })
  test("Claude waiting Stop and child completion do not settle the parent", () => {
    expect(lifecycle({ hook_event_name: "Stop", background_tasks: [{ id: "child", type: "subagent", status: "running" }] })).toBeUndefined()
    expect(lifecycle({ hook_event_name: "SubagentStop", agent_id: "child" })).toBeUndefined()
    expect(lifecycle({ hook_event_name: "Stop", background_tasks: [] })?.eventType).toBe("Idle")
    expect(lifecycle({ hook_event_name: "Stop", background_tasks: [{ status: "completed" }] })?.eventType).toBe("Idle")
  })

  test("a subagent's hooks never settle the terminal's turn, and its asks still wait on the person", () => {
    for (const hook_event_name of ["Stop", "SubagentStop", "SubagentStart", "SessionEnd", "Interrupt", "StopFailure"]) {
      expect(lifecycle({ hook_event_name, session_id: "codex-main", agent_id: "child-1" })).toBeUndefined()
    }
    expect(lifecycle({ hook_event_name: "PermissionRequest", session_id: "codex-main", agentId: "child-1" })?.eventType).toBe("UserActionRequired")
    expect(lifecycle({ hook_event_name: "SubagentStop", session_id: "codex-main" })).toBeUndefined()
    expect(lifecycle({ hook_event_name: "SubagentStart", session_id: "codex-main" })).toBeUndefined()
    expect(lifecycle({ hook_event_name: "Stop", session_id: "codex-main", turn_id: "turn-1" })?.eventType).toBe("Idle")
  })

  test("a Codex question to the person waits for them, and other tools do not", () => {
    const question = { hook_event_name: "PreToolUse", tool_name: "request_user_input", tool_input: { questions: [{ id: "q" }] } }
    expect(lifecycle(question)).toMatchObject({ eventType: "UserActionRequired", userAction: { toolKey: JSON.stringify(question.tool_input) } })
    expect(lifecycle({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } })).toBeUndefined()
  })

  test("preserves JSON string contents and takes the final Codex input message", () => {
    const prompt = 'Use "quoted" names\\paths\nand unicode π'
    expect(lifecycle({ type: "agent-turn-complete", "thread-id": "thread", "input-messages": ["earlier", prompt], "last-assistant-message": prompt })).toMatchObject({
      eventType: "Idle", provider: "codex", sessionId: "thread", prompt, lastAssistantMessage: prompt,
    })
  })

  test.each([
    ["Claude", "UserPromptSubmit", "Stop"],
    ["Gemini", "BeforeAgent", "AfterAgent"],
    ["Cursor", "beforeSubmitPrompt", "stop"],
    ["Copilot", "userPromptSubmitted", "sessionEnd"],
    ["MastraCode", "Start", "Stop"],
    ["Droid", "PostToolUse", "Stop"],
  ])("retains %s lifecycle boundary events", (_provider, start, stop) => {
    expect(lifecycle({ hook_event_name: start })?.eventType).toBe("Busy")
    expect(lifecycle({ hook_event_name: stop })?.eventType).toBe("Idle")
  })

  test("pairs a tool's ask with its completion by the input both sides repeat", () => {
    const bash = { command: "bun test", description: "run tests" }
    expect(lifecycle({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: bash })).toMatchObject({
      eventType: "UserActionRequired", userAction: { toolKey: "bun test" },
    })
    expect(lifecycle({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: bash, tool_use_id: "t1" })).toMatchObject({
      eventType: "Busy", toolCompletion: { toolKey: "bun test" },
    })
    const edit = { file_path: "/repo/a.ts", old_string: "x", new_string: "y" }
    expect(lifecycle({ hook_event_name: "PermissionRequest", tool_name: "Edit", tool_input: edit })?.userAction).toEqual({ toolKey: JSON.stringify(edit) })
    expect(lifecycle({ hook_event_name: "beforeShellExecution", command: "ls", cwd: "/repo" })?.userAction).toEqual({ toolKey: "ls" })
    expect(lifecycle({ hook_event_name: "postToolUse", tool_name: "Shell", tool_input: { command: "ls", cwd: "/repo" } })?.toolCompletion).toEqual({ toolKey: "ls" })
    expect(lifecycle({ hook_event_name: "beforeMCPExecution", tool_name: "search", tool_input: "{\"q\":1}", command: "node server.js" })?.userAction).toEqual({ toolKey: null })
    expect(lifecycle({ hook_event_name: "Notification", message: "Claude needs your permission" })?.userAction).toEqual({ toolKey: null })
    const submit = lifecycle({ hook_event_name: "UserPromptSubmit", prompt: "hi" })
    expect(submit).not.toHaveProperty("userAction")
    expect(submit).not.toHaveProperty("toolCompletion")
  })

  test("a failed or denied tool completes its call while only StopFailure ends the turn", () => {
    const bash = { command: "bun test" }
    expect(lifecycle({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: bash, error: "exit 1" })).toMatchObject({
      eventType: "Busy", toolCompletion: { toolKey: "bun test" },
    })
    expect(lifecycle({ hook_event_name: "PermissionDenied", tool_name: "Bash", tool_input: bash, tool_use_id: "t1", reason: "user" })).toMatchObject({
      eventType: "Busy", toolCompletion: { toolKey: "bun test" },
    })
    expect(lifecycle({ hook_event_name: "postToolUseFailure", tool_name: "Shell", tool_input: { command: "ls", cwd: "/repo" }, failure_type: "permission_denied" })).toMatchObject({
      eventType: "Busy", toolCompletion: { toolKey: "ls" },
    })
    expect(lifecycle({ hook_event_name: "StopFailure", session_id: "s" })).toMatchObject({ eventType: "Error" })
    expect(lifecycle({ hook_event_name: "StopFailure", session_id: "s" })).not.toHaveProperty("toolCompletion")
  })

  test("does not invent an event for unrelated provider payloads", () => {
    expect(lifecycle({ hook_event_name: "toString" })).toBeUndefined()
    expect(lifecycle({})).toBeUndefined()
  })
})
