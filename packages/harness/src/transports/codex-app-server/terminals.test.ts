import { expect, test } from "bun:test"
import { CodexTerminals } from "./terminals"
import { CodexTransportError } from "./errors"
import type { CodexRpc } from "./rpc"

const deadline = () => ({ at: Date.now() + 10_000, signal: new AbortController().signal })

function commandTurn(terminals: CodexTerminals, turnId: string, processId: string) {
  terminals.observe({ method: "item/started", params: { threadId: "thread-1", turnId, item: { type: "commandExecution", processId } } })
}

test("Codex stop waits for this turn's completion, pages the inventory, and terminates only this turn's process", async () => {
  const calls: { method: string; params: unknown }[] = []
  let terminated = false
  let terminals!: CodexTerminals
  const rpc = { request: async (method: string, params: unknown) => {
    calls.push({ method, params })
    if (method === "turn/interrupt") {
      queueMicrotask(() => terminals.observe({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1" } } }))
      return {}
    }
    if (method === "thread/backgroundTerminals/terminate") { terminated = true; return {} }
    if (terminated) return { data: [] }
    return "cursor" in (params as Record<string, unknown>) ? { data: [{ processId: "terminal-owned" }] } :
      { data: [{ processId: "terminal-other" }], nextCursor: "page-2" }
  } } as CodexRpc
  terminals = new CodexTerminals(rpc, "thread-1")
  commandTurn(terminals, "turn-1", "terminal-owned")
  expect(terminals.ranCommand("turn-1")).toBe(true)
  const result = await terminals.stop("turn-1", deadline())
  expect(result).toEqual({ execution: "terminal", cleanup: "verified_clear" })
  expect(calls.map((call) => call.method)).toEqual(["turn/interrupt", "thread/backgroundTerminals/list",
    "thread/backgroundTerminals/list", "thread/backgroundTerminals/terminate", "thread/backgroundTerminals/list"])
  expect(calls.find((call) => call.method === "thread/backgroundTerminals/terminate")?.params).toEqual({
    threadId: "thread-1", processId: "terminal-owned",
  })
})

test("an inventory the app-server refuses leaves cleanup unknown instead of failing the stop", async () => {
  let terminals!: CodexTerminals
  const rpc = { request: async (method: string) => {
    if (method === "turn/interrupt") {
      queueMicrotask(() => terminals.observe({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1" } } }))
      return {}
    }
    throw new CodexTransportError("protocol", "Invalid request: unknown variant `thread/backgroundTerminals/list`")
  } } as CodexRpc
  terminals = new CodexTerminals(rpc, "thread-1")
  commandTurn(terminals, "turn-1", "terminal-owned")
  expect(await terminals.stop("turn-1", deadline())).toEqual({ execution: "terminal", cleanup: "unknown",
    error: { code: "cancellation_unsupported", message: "Invalid request: unknown variant `thread/backgroundTerminals/list`" } })
})

test("a completed turn that observed no command has nothing to clean up and reads no inventory", async () => {
  const calls: string[] = []
  let terminals!: CodexTerminals
  const rpc = { request: async (method: string) => {
    calls.push(method)
    queueMicrotask(() => terminals.observe({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1" } } }))
    return {}
  } } as CodexRpc
  terminals = new CodexTerminals(rpc, "thread-1")
  terminals.observe({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-other" } } })
  expect(terminals.ranCommand("turn-1")).toBe(false)
  expect(await terminals.stop("turn-1", deadline())).toEqual({ execution: "terminal", cleanup: "verified_clear" })
  expect(calls).toEqual(["turn/interrupt"])
})

test("a completion that never arrives before the deadline leaves execution and cleanup unknown", async () => {
  const rpc = { request: async () => ({}) } as unknown as CodexRpc
  const terminals = new CodexTerminals(rpc, "thread-1")
  expect(await terminals.stop("turn-1", { at: Date.now() + 50, signal: new AbortController().signal }))
    .toEqual({ execution: "unknown", cleanup: "unknown" })
})

test("each page receives a fresh request budget during a paged terminal stop", async () => {
  const reads: number[] = []
  let terminated = false
  const rpc = { request: async (method: string, params: { cursor?: string }, budget: number) => {
    const started = Date.now()
    await new Promise((resolve) => setTimeout(resolve, 10))
    if (method === "thread/backgroundTerminals/terminate") { terminated = true; return {} }
    if (method !== "thread/backgroundTerminals/list") return {}
    reads.push(started + budget)
    if (terminated) return { data: [] }
    return params.cursor ? { data: [{ processId: "owned" }] } : { data: [], nextCursor: "second" }
  } } as unknown as CodexRpc
  const terminals = new CodexTerminals(rpc, "thread-1")
  commandTurn(terminals, "turn-1", "owned")
  terminals.observe({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1" } } })
  expect(await terminals.stop("turn-1", { at: Date.now() + 60_000, signal: new AbortController().signal }))
    .toEqual({ execution: "terminal", cleanup: "verified_clear" })
  expect(reads).toHaveLength(3)
  expect(new Set(reads).size).toBe(3)
  expect(reads.at(-1)!).toBeGreaterThan(reads[0]!)
})
