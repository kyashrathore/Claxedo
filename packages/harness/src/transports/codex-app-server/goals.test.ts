import { expect, test } from "bun:test"
import type { AdapterCancelOutcome } from "@claxedo/agent-runtime-contract"
import type { HarnessSession, SessionBroker } from "../../contract"
import { createCodexGoals } from "./goals"
import { CodexTransportError } from "./errors"
import type { CodexRpc } from "./rpc"
import { CodexTerminals } from "./terminals"

const session = { binding: { sessionId: "s1", upstreamSessionId: "thread-1" } } as HarnessSession

function goalEntry(stop: () => Promise<AdapterCancelOutcome>, ranCommand: boolean) {
  const calls: string[] = []
  const rpc = { request: async (method: string) => {
    calls.push(method)
    if (method === "thread/goal/clear") return { cleared: true }
    if (method === "thread/goal/set") return { goal: { objective: "work", status: "paused" } }
    throw new Error(`Unexpected Codex request ${method}`)
  } } as CodexRpc
  const notices: unknown[] = []
  const broker = { goal: { publish: async () => { calls.push("publish-goal") } },
    publish: async (event: unknown) => { calls.push("publish-notice"); notices.push(event) } } as unknown as SessionBroker
  const terminals = { stop: async () => { calls.push("turn/interrupt"); return stop() }, ranCommand: () => ranCommand } as unknown as CodexTerminals
  const entry = { rpc, broker, goal: null, terminals, providerTurn: { id: "turn-1" } }
  return { goals: createCodexGoals(() => entry), calls, notices, entry }
}

test.each(["stop", "pause"] as const)("Codex %s keeps the goal when the turn is not confirmed stopped", async (action) => {
  const { goals, calls, entry } = goalEntry(async () => ({ execution: "unknown", cleanup: "unknown" }), true)
  expect(await goals[action](session)).toMatchObject({ ok: false, status: "failed" })
  expect(calls).toEqual(["turn/interrupt"])
  expect(entry.goal).toBeNull()
})

test.each(["stop", "pause"] as const)("Codex %s proceeds with a notice when a command's cleanup is unverified", async (action) => {
  const { goals, calls, notices } = goalEntry(async () => ({ execution: "terminal", cleanup: "unknown" }), true)
  expect((await goals[action](session)).ok).toBe(true)
  expect(calls).toEqual(["turn/interrupt", "publish-notice", action === "stop" ? "thread/goal/clear" : "thread/goal/set", "publish-goal"])
  expect(notices[0]).toMatchObject({ type: "harness-notice", code: "codex.background_commands_unverified", severity: "warn" })
})

test.each(["stop", "pause"] as const)("Codex %s proceeds silently when the turn ran no command", async (action) => {
  const { goals, calls } = goalEntry(async () => ({ execution: "terminal", cleanup: "unknown" }), false)
  expect((await goals[action](session)).ok).toBe(true)
  expect(calls).toEqual(["turn/interrupt", action === "stop" ? "thread/goal/clear" : "thread/goal/set", "publish-goal"])
})

test("Codex stop propagates an interrupt failure", async () => {
  const { goals } = goalEntry(async () => { throw new CodexTransportError("protocol", "permission denied") }, false)
  expect(await goals.stop(session)).toMatchObject({ ok: false, status: "failed", message: "permission denied" })
})

test.each(["stop", "pause"] as const)("Codex %s interrupts before publishing the goal transition", async (action) => {
  const { goals, calls } = goalEntry(async () => ({ execution: "terminal", cleanup: "verified_clear" }), true)
  expect((await goals[action](session)).ok).toBe(true)
  expect(calls).toEqual(["turn/interrupt", action === "stop" ? "thread/goal/clear" : "thread/goal/set", "publish-goal"])
})
