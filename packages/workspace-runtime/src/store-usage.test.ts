import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { RuntimeUsageObservation } from "@claxedo/agent-runtime-contract"
import type { RuntimeStore } from "./store"
import { openRuntimeStore } from "./store-file"
import { sessionUsage } from "./projection/presentation-events"

const opened: Array<{ root: string; store: RuntimeStore }> = []

afterEach(() => {
  for (const { root, store } of opened.splice(0)) {
    store.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function turnStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wr-store-usage-"))
  const store = openRuntimeStore(root)
  opened.push({ root, store })
  store.bindSession({ owner: { kind: "machine-owner" }, sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
  store.startTurn({
    sessionId: "s1",
    agentSessionId: "a1",
    userMessageId: "u1",
    assistantMessageId: "u1_r",
    agent: "general",
    model: { providerID: "claude-sdk", modelID: "claude-sonnet-4-6" },
    parts: [{ type: "text", text: "hello" }],
  })
  return store
}

function report(store: RuntimeStore, observation: RuntimeUsageObservation, messageID = "u1_r") {
  return store.appendEvent({
    sessionId: "s1",
    agentSessionId: "a1",
    payload: sessionUsage({ sessionID: "s1", messageID, contextSize: 0, contextUsed: 0, observation }),
  })
}

function tokens(input: number, output: number, read: number | null = null) {
  return { input, output, reasoning: null, cache: { read, write: null } }
}

function storedTokens(store: RuntimeStore, messageId = "u1_r") {
  return store.getMessages("s1").find((message) => message.info.id === messageId)?.info.tokens
}

test("usage folds into the assistant message it names and the append returns that message", () => {
  const store = turnStore()
  report(store, { kind: "cumulative", scope: "thread", tokens: tokens(3, 1, 100) })
  report(store, { kind: "cumulative", scope: "thread", tokens: tokens(5, 2, 120) })
  report(store, { kind: "delta", scope: "child", providerObservationId: "c1", tokens: tokens(7, 4) })
  const repeated = report(store, { kind: "delta", scope: "child", providerObservationId: "c1", tokens: tokens(7, 4) })

  const folded = { input: 12, output: 6, reasoning: 0, cache: { read: 120, write: 0 } }
  expect(storedTokens(store)).toEqual(folded)
  expect(repeated.messageUpdate?.type).toBe("message.updated")
  expect(repeated.messageUpdate?.type === "message.updated" && repeated.messageUpdate.properties.info).toMatchObject({ id: "u1_r", tokens: folded })
})

test("a later rebuild of the message keeps its usage, and a replay derives the same tokens", () => {
  const store = turnStore()
  report(store, { kind: "cumulative", tokens: tokens(11, 5, 1) })
  const leaseId = store.readTurnAuthority("s1")?.leaseId ?? store.acquireTurnLease("s1")
  if (!leaseId) throw new Error("the session has no turn lease")
  store.finishTurn({ sessionId: "s1", assistantMessageId: "u1_r", outcome: { status: "failed", completedAt: 5, error: "boom" }, leaseId })

  const folded = { input: 11, output: 5, reasoning: 0, cache: { read: 1, write: 0 } }
  expect(store.getMessages("s1").find((message) => message.info.id === "u1_r")?.info).toMatchObject({ tokens: folded, error: expect.anything() })
  store.releaseTurnLease("s1", leaseId)
  store.rebuildProjection("s1")
  expect(storedTokens(store)).toEqual(folded)
})

test("usage naming no stored assistant message changes no message and returns none", () => {
  const store = turnStore()
  const output = report(store, { kind: "cumulative", tokens: tokens(4, 2) }, "u1")
  expect(output.messageUpdate).toBeUndefined()
  expect(storedTokens(store, "u1")).toBeUndefined()
  expect(storedTokens(store)).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
})
