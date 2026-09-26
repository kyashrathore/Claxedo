import { expect, test } from "bun:test"
import { CodexTerminals } from "./terminals"
import type { CodexRpc } from "./rpc"

test("Codex stop pages the terminal inventory and terminates only this turn's process", async () => {
  const calls: { method: string; params: unknown }[] = []
  let terminated = false
  const rpc = { request: async (method: string, params: unknown) => {
    calls.push({ method, params })
    if (method === "turn/interrupt") return {}
    if (method === "thread/backgroundTerminals/terminate") { terminated = true; return {} }
    if (terminated) return { data: [] }
    return "cursor" in (params as Record<string, unknown>) ? { data: [{ processId: "terminal-owned" }] } :
      { data: [{ processId: "terminal-other" }], nextCursor: "page-2" }
  } } as CodexRpc
  const terminals = new CodexTerminals(rpc, "thread-1")
  terminals.observe({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1",
    item: { type: "commandExecution", processId: "terminal-owned" } } })
  const result = await terminals.stop("turn-1", { at: Date.now() + 10_000, signal: new AbortController().signal })
  expect(result).toEqual({ execution: "unknown", cleanup: "verified_clear" })
  expect(calls.map((call) => call.method)).toEqual(["turn/interrupt", "thread/backgroundTerminals/list",
    "thread/backgroundTerminals/list", "thread/backgroundTerminals/terminate", "thread/backgroundTerminals/list"])
  expect(calls.find((call) => call.method === "thread/backgroundTerminals/terminate")?.params).toEqual({
    threadId: "thread-1", processId: "terminal-owned",
  })
})

test("Codex confirmation waits for this turn and verifies the remaining terminal inventory", async () => {
  const rpc = { request: async (method: string) => method === "thread/backgroundTerminals/list" ? { data: [] } : {} } as CodexRpc
  const terminals = new CodexTerminals(rpc, "thread-1")
  const deadline = { at: Date.now() + 1_000, signal: new AbortController().signal }
  const confirmation = terminals.confirm("turn-1", { execution: "unknown", cleanup: "unknown" }, deadline)
  terminals.observe({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-other" } } })
  terminals.observe({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1" } } })
  expect(await confirmation).toEqual({ execution: "terminal", cleanup: "verified_clear" })
})
