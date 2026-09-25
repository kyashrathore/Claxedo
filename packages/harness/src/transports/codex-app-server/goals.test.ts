import { expect, test } from "bun:test"
import type { HarnessSession, SessionBroker } from "../../contract"
import { createCodexGoals } from "./goals"
import { CodexNoActiveTurnError, CodexTransportError } from "./errors"
import type { CodexRpc } from "./rpc"
import { CodexTerminals } from "./terminals"

const session = { binding: { sessionId: "s1", upstreamSessionId: "thread-1" } } as HarnessSession

function stoppedGoal(interruptError: Error) {
  const requests: string[] = []
  const rpc = { request: async (method: string) => {
    requests.push(method)
    if (method === "thread/goal/clear") return { cleared: true }
    if (method === "thread/goal/set") return { goal: { objective: "work", status: "paused" } }
    throw new Error(`Unexpected Codex request ${method}`)
  } } as CodexRpc
  const broker = { goal: { publish: async () => {} } } as unknown as SessionBroker
  const terminals = { stop: async () => {
    requests.push("turn/interrupt")
    if (!(interruptError instanceof CodexNoActiveTurnError)) throw interruptError
    return { execution: "terminal", cleanup: "unknown" }
  }, confirm: async () => { requests.push("confirm"); return { execution: "terminal", cleanup: "owned" } } } as unknown as CodexTerminals
  const entry = { rpc, broker, goal: null, terminals, providerTurn: { id: "turn-1" } }
  return { goals: createCodexGoals(() => entry), requests }
}

test.each(["stop", "pause"] as const)("Codex %s keeps the goal when background cleanup is unverified", async (action) => {
  const { goals, requests } = stoppedGoal(new CodexNoActiveTurnError())
  expect((await goals[action](session)).ok).toBe(false)
  expect(requests).toEqual(["turn/interrupt", "confirm"])
})

test("Codex stop propagates other interrupt failures", async () => {
  const { goals } = stoppedGoal(new CodexTransportError("protocol", "permission denied"))
  expect(await goals.stop(session)).toMatchObject({ ok: false, status: "failed", message: "permission denied" })
})

test.each(["stop", "pause"] as const)("Codex %s interrupts before publishing the goal transition", async (action) => {
  const calls: string[] = []
  const rpc = { request: async (method: string) => {
    calls.push(method)
    return method === "thread/goal/clear" ? { cleared: true } : { goal: { objective: "work", status: "paused" } }
  } } as CodexRpc
  const broker = { goal: { publish: async () => { calls.push("publish") } } } as unknown as SessionBroker
  const terminals = { stop: async () => { calls.push("interrupt"); return { execution: "terminal", cleanup: "verified_clear" } } } as unknown as CodexTerminals
  const entry = { rpc, broker, goal: null, terminals, providerTurn: { id: "turn-1" } }
  const goals = createCodexGoals(() => entry)
  expect((await goals[action](session)).ok).toBe(true)
  expect(calls).toEqual(["interrupt", action === "stop" ? "thread/goal/clear" : "thread/goal/set", "publish"])
})
