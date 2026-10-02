import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { assistantMessageIdForTurn, createMessageIds } from "@claxedo/agent-runtime-contract"
import type { RuntimeStore } from "../store"
import { openTestRuntimeStore } from "../test-support/store"
import { createRuntimeEventHub } from "../projection/runtime-event-hub"
import { createStoreBrokerPorts } from "./index"

const opened: { store: RuntimeStore; root: string }[] = []

afterEach(() => {
  for (const { store, root } of opened.splice(0)) {
    store.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-"))
  const store = openTestRuntimeStore(root)
  opened.push({ store, root })
  store.bindSession({ owner: { kind: "machine-owner" }, sessionId: "s1", workspaceId: "w1", directory: "/work", connectionId: "c1", upstreamSessionId: "up1", agentSessionId: "up1", createdAt: 1 })
  store.updateSessionConfig("s1", { harness: { id: "claude", access: "native" }, agent: "general", model: { providerID: "anthropic", modelID: "test" } })
  const ports = createStoreBrokerPorts(store, { ownerGeneration: "g1", patternEvaluator: async () => {}, publishers: createRuntimeEventHub(),
    reportOwnerFailure: () => {}, retainLeasedTurnFailure: () => false })
  const ids = createMessageIds()
  const prompt = () => {
    const userMessageId = ids()
    const assistantMessageId = assistantMessageIdForTurn(userMessageId)
    const leaseId = store.acquireTurnLease("s1")
    if (!leaseId) throw new Error("Prompt lease missing")
    store.startTurn({ sessionId: "s1", userMessageId, assistantMessageId, agent: "general", parts: [{ type: "text", text: "Start the child" }] })
    store.finishTurn({ sessionId: "s1", assistantMessageId, leaseId, outcome: { status: "completed", completedAt: Date.now() } })
    store.releaseTurnLease("s1", leaseId)
    return { userMessageId, assistantMessageId }
  }
  const continueTurn = (current: () => boolean = () => true) => ports.admitProviderTurn("s1", { reason: "continuation", current }, async (turn) => {
    await ports.drainProviderEvent("s1", turn, { event: { type: "text-delta", delta: "The report arrived." } })
    await ports.drainProviderEvent("s1", turn, { event: { type: "finish", sessionId: "s1" } })
  })
  return { store, prompt, continueTurn }
}

test("continuations keep one real prompt and distinct replies, including latest-turn paging", async () => {
  const { store, prompt, continueTurn } = setup()
  const first = prompt()
  const replies: string[] = []
  for (let index = 0; index < 2; index++) {
    const admitted = await continueTurn()
    if (!admitted.admitted) throw new Error("Continuation refused")
    expect(await admitted.settled).toEqual({ state: "completed" })
    replies.push(admitted.turn.assistantMessageId)
  }
  const messages = store.getMessages("s1")
  expect(messages.filter((message) => message.info.role === "user").map((message) => message.info.id)).toEqual([first.userMessageId])
  expect(new Set([first.assistantMessageId, ...replies]).size).toBe(3)
  expect(messages.filter((message) => message.info.role === "assistant").every((message) => message.info.parentID === first.userMessageId)).toBe(true)
  expect(store.getMessagePage("s1", { view: "latest-turn" })?.messages.map((message) => message.info.id))
    .toEqual([first.userMessageId, first.assistantMessageId, ...replies])
  expect(store.getMessagePage("s1", { view: "latest-surface" })?.messages.map((message) => message.info.id))
    .toEqual([first.userMessageId, replies.at(-1)!])
})

test("a later prompt is the conversational parent of the next continuation", async () => {
  const { store, prompt, continueTurn } = setup()
  prompt()
  const latest = prompt()
  const admitted = await continueTurn()
  if (!admitted.admitted) throw new Error("Continuation refused")
  await admitted.settled
  expect(store.getMessages("s1").find((message) => message.info.id === admitted.turn.assistantMessageId)?.info.parentID)
    .toBe(latest.userMessageId)
})

test("a continuation without a real prompt fails and releases its lease", async () => {
  const { store, continueTurn } = setup()
  await expect(continueTurn()).rejects.toThrow("has no prompt to answer")
  const leaseId = store.acquireTurnLease("s1")
  expect(leaseId).toBeString()
  if (leaseId) store.releaseTurnLease("s1", leaseId)
  expect(store.getMessages("s1")).toEqual([])
})

test("a continuation consumed by a human turn while waiting never writes another turn", async () => {
  const { store, prompt, continueTurn } = setup()
  prompt()
  const held = store.acquireTurnLease("s1")
  if (!held) throw new Error("Lease missing")
  let current = true
  const pending = continueTurn(() => current)
  current = false
  store.releaseTurnLease("s1", held)
  expect(await pending).toEqual({ admitted: false, reason: "busy" })
  expect(store.getMessages("s1")).toHaveLength(2)
})
