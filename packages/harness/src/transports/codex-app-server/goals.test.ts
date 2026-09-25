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
    throw interruptError
  } } as CodexRpc
  const broker = { goal: { publish: async () => {} } } as unknown as SessionBroker
  const entry = { rpc, broker, goal: null, terminals: new CodexTerminals(rpc, "thread-1"), providerTurn: { id: "turn-1" } }
  return { goals: createCodexGoals(() => entry), requests }
}

test.each(["stop", "pause"] as const)("Codex %s completes when the turn ends before interrupt lands", async (action) => {
  const { goals, requests } = stoppedGoal(new CodexNoActiveTurnError())
  expect((await goals[action](session)).ok).toBe(true)
  expect(requests).toEqual([action === "stop" ? "thread/goal/clear" : "thread/goal/set", "turn/interrupt"])
})

test("Codex stop propagates other interrupt failures", async () => {
  const { goals } = stoppedGoal(new CodexTransportError("protocol", "permission denied"))
  await expect(goals.stop(session)).rejects.toThrow("permission denied")
})
