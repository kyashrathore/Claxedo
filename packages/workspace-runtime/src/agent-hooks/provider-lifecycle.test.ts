import { describe, expect, test } from "bun:test"
import { providerLifecycle } from "./provider-lifecycle"

describe("provider lifecycle normalization", () => {
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
