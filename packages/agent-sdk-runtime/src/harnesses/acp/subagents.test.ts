import { describe, expect, test } from "bun:test"
import { acpSubagentUpdate, supportsACPSubagents } from "./subagents"
import { createMemorySubagentAdmissionStore, createSubagentAdmissionBoundary } from "../../subagent-admission"

describe("ACP native subagent wire contract", () => {
  test("requires the published canonical or versioned AIR capability", () => {
    expect(supportsACPSubagents({ agentCapabilities: { sessionCapabilities: { subagents: {} } } })).toBe(true)
    expect(supportsACPSubagents({ _meta: { jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions"] } } } })).toBe(true)
    expect(supportsACPSubagents({ agentCapabilities: { subagents: {} } })).toBe(false)
    expect(supportsACPSubagents({ _meta: { jetbrains: { air: { capabilities: ["nativeSubagentSessions"] } } } })).toBe(false)
    expect(supportsACPSubagents({ agentCapabilities: { sessionCapabilities: { subagents: [] } } })).toBe(false)
  })

  test("admits authoritative identity once and settles the same child", async () => {
    const store = createMemorySubagentAdmissionStore()
    const published: unknown[] = []
    const boundary = createSubagentAdmissionBoundary({ store, publish: (_, event) => { published.push(event) } })
    const spawned = acpSubagentUpdate({ sessionUpdate: "subagent_spawned", subagentSessionId: "native-child", name: "Reviewer", task: "Review files", capabilities: {} })!
    const first = await boundary.admit("parent", spawned.observation, { allocateChildSessionId: () => "claxedo-child" })
    const replay = await boundary.admit("parent", spawned.observation)
    const completed = acpSubagentUpdate({ sessionUpdate: "subagent_state_update", subagentSessionId: "native-child", state: "completed" })!
    const last = await boundary.admit("parent", completed.observation)
    expect(first.providerId).toBe("native-child")
    expect(first.childSessionId).toBe("claxedo-child")
    expect(replay).toEqual(first)
    expect(last.subagentKey).toBe(first.subagentKey)
    expect(last.childSessionId).toBe(first.childSessionId)
    expect(last.status).toBe("completed")
    expect(published).toHaveLength(2)
    expect(spawned.capabilities).toEqual({ cancel: false, close: false })
  })

  test("does not infer children or controls from tool names and malformed events", () => {
    expect(acpSubagentUpdate({ sessionUpdate: "tool_call", title: "Task", toolCallId: "123" })).toBeUndefined()
    expect(acpSubagentUpdate({ sessionUpdate: "subagent_spawned", subagentSessionId: "", name: "a", task: "b", capabilities: {} })).toBeUndefined()
    expect(acpSubagentUpdate({ sessionUpdate: "subagent_spawned", subagentSessionId: "c", name: "a", task: "b", capabilities: { cancel: "yes" } })).toBeUndefined()
    expect(acpSubagentUpdate({ sessionUpdate: "subagent_state_update", subagentSessionId: "c", state: "whatever" })).toBeUndefined()
    for (const [state, status] of [["cancelled", "killed"], ["disconnected", "interrupted"], ["failed", "failed"]] as const) {
      expect(acpSubagentUpdate({ sessionUpdate: "subagent_state_update", subagentSessionId: "c", state })?.observation.status).toBe(status)
    }
  })
})
