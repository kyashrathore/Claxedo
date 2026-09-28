import { expect, test } from "bun:test"
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { HarnessSession, SessionBroker, StartInput, TurnBroker, TurnRef } from "../../contract"
import { ClaudeGoals } from "./goals"
import type { ClaudeQueryLauncher } from "./query-options"

const input: StartInput = { sessionId: "s1", workspaceId: "w1", directory: "/work", locality: "local",
  owner: { kind: "machine-owner" }, config: { harness: { id: "claude", access: "native" } },
  projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] },
  credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "g1" } }

function session(): HarnessSession {
  return { directory: "/work", locality: "local", binding: { sessionId: "s1", workspaceId: "w1", directory: "/work",
    connectionId: "claude-sdk", upstreamSessionId: "up1" } }
}

function entry() {
  return { session: session(), input }
}

function stream(messages: AsyncIterable<SDKMessage>): Query {
  return { [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](), close() {} } as Query
}

const admitted: TurnRef = { turnId: "goal-turn", assistantMessageId: "goal-assistant" }

function broker(initial: "active" | "absent" = "absent") {
  let goal: { sessionId: string; objective: string; status: "active" | "paused" | "blocked"; createdAt: number; updatedAt: number; lastReason?: string } | null =
    initial === "active" ? { sessionId: "s1", objective: "Ship", status: "active", createdAt: 1, updatedAt: 1 } : null
  let settled: Promise<unknown> | undefined
  const value = { sessionId: "s1", config: () => input.config, rebind: async (upstreamSessionId: string) => ({ ...session().binding, upstreamSessionId }),
    goal: { read: () => goal, publish: async (next: typeof goal) => { goal = next } },
    admitProviderTurn: async (_request: unknown, run: (turn: TurnBroker, ref: TurnRef) => AsyncIterable<unknown>) => {
      settled = (async () => {
        try { for await (const _event of run({ signal: new AbortController().signal } as TurnBroker, admitted)) {} return { state: "completed" as const } }
        catch (error) { return { state: "failed" as const, error: error instanceof Error ? error.message : String(error) } }
      })()
      return { admitted: true as const, turn: admitted, settled }
    } } as unknown as SessionBroker
  return { value, settled: () => settled }
}

test("a native Goal runs under the admitted turn's identity", async () => {
  const state = broker()
  const specs: Parameters<ClaudeQueryLauncher["launch"]>[0][] = []
  const launcher = { launch: async (spec: Parameters<ClaudeQueryLauncher["launch"]>[0]) => {
    specs.push(spec)
    return stream({ async *[Symbol.asyncIterator]() {
      yield { type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "up1" } as SDKMessage
    } })
  } } as unknown as ClaudeQueryLauncher
  const goals = new ClaudeGoals(launcher)
  expect((await goals.start(entry(), state.value, "Ship")).ok).toBe(true)
  expect(goals.turnId("s1")).toBe("goal-turn")
  await state.settled()
  expect(specs[0]).toMatchObject({ turnId: "goal-turn", assistantMessageId: "goal-assistant" })
})

test("a dead native Goal query settles failed and blocks the active Goal", async () => {
  const state = broker()
  const launcher = { launch: async () => stream({ async *[Symbol.asyncIterator]() {
    yield { type: "active_goal", session_id: "up1", uuid: "g1", value: { condition: "Ship", iterations: 1,
      set_at: 1_700_000_000, tokens_at_start: 0 } } as unknown as SDKMessage
    throw new Error("query died")
  } }) } as unknown as ClaudeQueryLauncher
  const goals = new ClaudeGoals(launcher)
  expect((await goals.start(entry(), state.value, "Ship")).ok).toBe(true)
  await state.settled()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(state.value.goal.read()).toMatchObject({ status: "blocked", lastReason: "query died" })
  expect(goals.turnId("s1")).toBeUndefined()
})

test("an unconfirmed clear leaves the Goal blocked", async () => {
  const state = broker("active")
  const launcher = { launch: async () => stream({ async *[Symbol.asyncIterator]() {
    yield { type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "up1" } as SDKMessage
  } }) } as unknown as ClaudeQueryLauncher
  const result = await new ClaudeGoals(launcher).stop(entry(), state.value)
  expect(result).toMatchObject({ ok: false, status: "failed" })
  expect(state.value.goal.read()).toMatchObject({ status: "blocked", lastReason: "Claude did not confirm clearing the native Goal" })
})

test("stop drains the admitted Goal turn before clearing it", async () => {
  const order: string[] = []
  const state = broker("active")
  const launcher = { launch: async (spec: Parameters<ClaudeQueryLauncher["launch"]>[0]) => {
    if (spec.clear) {
      order.push("clear launched")
      return stream({ async *[Symbol.asyncIterator]() {
        yield { type: "result", subtype: "success", is_error: false, num_turns: 0, session_id: "up1" } as SDKMessage
      } })
    }
    return stream({ async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => spec.abort.signal.addEventListener("abort", () => resolve(), { once: true }))
      order.push("goal drained")
    } })
  } } as unknown as ClaudeQueryLauncher
  const goals = new ClaudeGoals(launcher)
  const current = entry()
  expect((await goals.start(current, state.value, "Ship")).ok).toBe(true)
  const stopped = await goals.stop(current, state.value)
  expect(stopped).toMatchObject({ ok: true, goal: { status: "paused" } })
  expect(order).toEqual(["goal drained", "clear launched"])
})

test("goal cancellation returns a failed settlement when owned retirement fails", async () => {
  const state = broker("active")
  const launcher = { launch: async (spec: Parameters<ClaudeQueryLauncher["launch"]>[0]) => {
    spec.processes.add({ retire: async () => { throw new Error("retirement failed") } } as unknown as import("./process").ClaudeProcess)
    return stream({ async *[Symbol.asyncIterator]() {
      if (!spec.abort.signal.aborted) await new Promise<void>((resolve) => spec.abort.signal.addEventListener("abort", () => resolve(), { once: true }))
    } })
  } } as unknown as ClaudeQueryLauncher
  const goals = new ClaudeGoals(launcher)
  expect((await goals.start(entry(), state.value, "Ship")).ok).toBe(true)
  expect(await goals.cancel("s1")).toEqual({ state: "failed", error: "retirement failed" })
})

test("a Goal stream that ends without a result fails with the transport's protocol error", async () => {
  const state = broker()
  const launcher = { launch: async () => stream({ async *[Symbol.asyncIterator]() {} }) } as unknown as ClaudeQueryLauncher
  const goals = new ClaudeGoals(launcher)
  expect((await goals.start(entry(), state.value, "Ship")).ok).toBe(true)
  expect(await state.settled()).toEqual({ state: "failed", error: "Claude SDK stream ended without a result" })
})
