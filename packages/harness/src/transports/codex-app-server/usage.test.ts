import { expect, test } from "bun:test"
import { CodexUsageLedger } from "./usage"

function report(threadId: string, total: number, last: number) {
  const tokens = (inputTokens: number) => ({ inputTokens, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: inputTokens })
  return { method: "thread/tokenUsage/updated", params: { threadId, turnId: "turn-1", tokenUsage: { total: tokens(total), last: tokens(last), modelContextWindow: 200_000 } } }
}

const fact = { sessionId: "s1", directory: "/work", assistantMessageId: "a1" }

test("usage growth outside a turn is billed to the session's last turn as a delta", () => {
  const ledger = new CodexUsageLedger()
  ledger.attach(fact)
  expect(ledger.observe(report("thread-1", 10, 10), "owned")).toEqual({})
  const detached = ledger.observe(report("thread-1", 14, 4), "detached")
  expect(detached.usage).toMatchObject({ sessionId: "s1", directory: "/work", assistantMessageId: "a1",
    usage: { type: "usage", observation: { kind: "delta", scope: "detached:thread-1" } } })
  expect(ledger.observe(report("thread-1", 14, 4), "detached")).toEqual({})
})

test("a title side thread's usage is Claxedo's own request and is not metered to the session's turn", () => {
  const usage = (inputTokens: number, outputTokens: number, reasoningOutputTokens: number) =>
    ({ inputTokens, cachedInputTokens: 0, outputTokens, reasoningOutputTokens, totalTokens: inputTokens + outputTokens })
  const tokenUsage = (threadId: string, turnId: string, tokens: ReturnType<typeof usage>) =>
    ({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: tokens, last: tokens, modelContextWindow: 258_400 } } })
  const ledger = new CodexUsageLedger()
  ledger.attach(fact)
  expect(ledger.observe({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } }, "owned")).toEqual({})
  expect(ledger.observe(tokenUsage("thread-1", "turn-1", usage(11_374, 5, 0)), "owned")).toEqual({})
  expect(ledger.observe({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } }, "detached")).toEqual({})
  expect(ledger.observe(tokenUsage("title-1", "title-turn-1", usage(10_646, 69, 47)), "side")).toEqual({})
  expect(ledger.observe(tokenUsage("thread-1", "turn-1", usage(11_374, 5, 0)), "detached")).toEqual({})
})

test("usage on a thread this transport never started, or before any turn, is reported unbilled", () => {
  const ledger = new CodexUsageLedger()
  expect(ledger.observe(report("thread-1", 10, 10), "detached")).toEqual({ unbilled: "thread-1" })
  ledger.attach(fact)
  expect(ledger.observe(report("stranger", 3, 3), "unknown")).toEqual({ unbilled: "stranger" })
  expect(ledger.observe({ method: "turn/started", params: { threadId: "thread-1" } }, "owned")).toEqual({})
})
