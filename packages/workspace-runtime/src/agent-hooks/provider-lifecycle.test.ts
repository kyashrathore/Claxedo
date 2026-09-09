import { describe, expect, test } from "bun:test"
import { providerLifecycle } from "./provider-lifecycle"

describe("provider lifecycle normalization", () => {
  test("native interruption settles as cancellation without a success outcome", () => {
    expect(providerLifecycle({ hook_event_name: "Interrupt", session_id: "codex-main", turn_id: "turn-1" })).toMatchObject({
      eventType: "Idle", outcome: "cancelled", sessionId: "codex-main",
    })
  })

  test("Antigravity settles only an idle execution, never an individual model invocation", () => {
    const input = { provider: "antigravity", event: { conversationId: "agy-main", transcriptPath: "/tmp/transcript.jsonl" } }
    expect(providerLifecycle({ ...input, hook_event_name: "PreInvocation" })).toMatchObject({ eventType: "Busy", sessionId: "agy-main" })
    expect(providerLifecycle({ ...input, hook_event_name: "PostInvocation" })).toBeUndefined()
    const stop = { ...input, hook_event_name: "Stop" }
    expect(providerLifecycle({ ...stop, event: { ...input.event, fullyIdle: false, terminationReason: "model_stop" } })).toBeUndefined()
    expect(providerLifecycle({ ...stop, event: { ...input.event, terminationReason: "model_stop" } })).toBeUndefined()
    expect(providerLifecycle({ ...stop, event: { ...input.event, fullyIdle: true, terminationReason: "model_stop" } })).toMatchObject({ eventType: "Idle", outcome: "done", sessionId: "agy-main" })
    expect(providerLifecycle({ ...stop, event: { ...input.event, fullyIdle: true, terminationReason: "error" } })).toMatchObject({ eventType: "Error", outcome: "error" })
    expect(providerLifecycle({ ...stop, event: { ...input.event, fullyIdle: true, terminationReason: "unknown" } })).toBeUndefined()
  })
  test("Amp preserves thread identity and distinguishes completed, failed and cancelled turns", () => {
    const event = { thread: { id: "T-amp" }, id: "M-1", message: "hello" }
    expect(providerLifecycle({ provider: "amp", hook_event_name: "agent.start", event })).toMatchObject({ provider: "amp", sessionId: "T-amp", eventType: "Busy" })
    for (const outcome of ["done", "error", "cancelled"] as const) {
      expect(providerLifecycle({ provider: "amp", hook_event_name: "agent.end", event: { ...event, status: outcome } })).toMatchObject({
        eventType: outcome === "error" ? "Error" : "Idle", outcome, sessionId: "T-amp",
      })
    }
    expect(providerLifecycle({ provider: "amp", hook_event_name: "agent.end", event })).toBeUndefined()
    expect(providerLifecycle({ provider: "amp", hook_event_name: "tool.result", event: { ...event, status: "done" } })).toBeUndefined()
  })
  test("Claude waiting Stop and child completion do not settle the parent", () => {
    expect(providerLifecycle({ hook_event_name: "Stop", background_tasks: [{ id: "child", type: "subagent", status: "running" }] })).toBeUndefined()
    expect(providerLifecycle({ hook_event_name: "SubagentStop", agent_id: "child" })).toBeUndefined()
    expect(providerLifecycle({ hook_event_name: "Stop", background_tasks: [] })?.eventType).toBe("Idle")
    expect(providerLifecycle({ hook_event_name: "Stop", background_tasks: [{ status: "completed" }] })?.eventType).toBe("Idle")
  })

  test("preserves JSON string contents and takes the final Codex input message", () => {
    const prompt = 'Use "quoted" names\\paths\nand unicode π'
    expect(providerLifecycle({ type: "agent-turn-complete", "thread-id": "thread", "input-messages": ["earlier", prompt], "last-assistant-message": prompt })).toMatchObject({
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
    expect(providerLifecycle({ hook_event_name: start })?.eventType).toBe("Busy")
    expect(providerLifecycle({ hook_event_name: stop })?.eventType).toBe("Idle")
  })

  test("does not invent an event for unrelated provider payloads", () => {
    expect(providerLifecycle({ hook_event_name: "toString" })).toBeUndefined()
    expect(providerLifecycle({})).toBeUndefined()
  })
})
