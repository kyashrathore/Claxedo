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
  return { goals: createCodexGoals(async () => entry), calls, notices, entry }
}

const transition = (action: "stop" | "pause") => action === "stop" ? "thread/goal/clear" : "thread/goal/set"

test.each(["stop", "pause"] as const)("Codex %s applies the goal state, then fails when the turn is not confirmed stopped", async (action) => {
  const { goals, calls, entry } = goalEntry(async () => ({ execution: "unknown", cleanup: "unknown" }), true)
  expect(await goals[action](session)).toMatchObject({ ok: false, status: "failed", message: "Codex turn was not confirmed stopped after the goal transition" })
  expect(calls).toEqual([transition(action), "publish-goal", "turn/interrupt"])
  expect(entry.goal).toEqual(action === "stop" ? null : expect.objectContaining({ status: "paused" }))
})

test.each(["stop", "pause"] as const)("Codex %s proceeds with a notice when a command's cleanup is unverified", async (action) => {
  const { goals, calls, notices } = goalEntry(async () => ({ execution: "terminal", cleanup: "unknown" }), true)
  expect((await goals[action](session)).ok).toBe(true)
  expect(calls).toEqual([transition(action), "publish-goal", "turn/interrupt", "publish-notice"])
  expect(notices[0]).toMatchObject({ type: "harness-notice", code: "codex.background_commands_unverified", severity: "warn" })
})

test.each(["stop", "pause"] as const)("Codex %s proceeds silently when the turn ran no command", async (action) => {
  const { goals, calls } = goalEntry(async () => ({ execution: "terminal", cleanup: "unknown" }), false)
  expect((await goals[action](session)).ok).toBe(true)
  expect(calls).toEqual([transition(action), "publish-goal", "turn/interrupt"])
})

test("Codex stop propagates an interrupt failure", async () => {
  const { goals } = goalEntry(async () => { throw new CodexTransportError("protocol", "permission denied") }, false)
  expect(await goals.stop(session)).toMatchObject({ ok: false, status: "failed", message: "permission denied" })
})

test.each(["stop", "pause"] as const)("Codex %s sets the goal state before interrupting, so no continuation starts in between", async (action) => {
  const { goals, calls } = goalEntry(async () => ({ execution: "terminal", cleanup: "verified_clear" }), true)
  expect((await goals[action](session)).ok).toBe(true)
  expect(calls).toEqual([transition(action), "publish-goal", "turn/interrupt"])
})

test("a started Codex goal reports success when publishing its snapshot fails, and the failure reaches the session owner", async () => {
  const { goals, entry } = goalEntry(async () => ({ execution: "terminal", cleanup: "verified_clear" }), false)
  const failures: unknown[] = []
  Object.assign(entry.broker, { goal: { publish: async () => { throw new Error("store unavailable") } }, reportFailure: (error: unknown) => failures.push(error) })
  expect(await goals.start(session, "work", entry.broker)).toMatchObject({ ok: true, goal: { objective: "work" } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(failures).toEqual([new Error("store unavailable")])
})
