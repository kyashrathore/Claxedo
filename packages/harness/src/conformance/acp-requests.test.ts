import { expect, test } from "bun:test"
import { collect, reached, wireFixture } from "./test-support/acp-wire"
import { AcpTransport } from "../transports/acp"
import { filterMcpServers } from "../capabilities/mcp-filter"

async function asking() {
  const f = wireFixture((_peer, message) => message.method === "session/prompt")
  const session = await f.start()
  const controller = new AbortController()
  const running = collect(f.transport.send(session, f.turn, f.turnBroker(controller.signal)))
    .then((events) => ({ events }), (error: unknown) => ({ error }))
  const peer = f.peers[0]!
  const prompt = await reached(() => peer.messages.find((row) => row.method === "session/prompt"))
  peer.elicit("form-wire", { sessionId: session.binding.upstreamSessionId })
  const pending = await reached(() => f.owner.broker.list({ sessionId: "s1" })[0])
  const finish = async () => { peer.reply(prompt, { stopReason: "end_turn" }); await running; await f.transport.dispose() }
  return { ...f, session, controller, running, peer, pending, finish }
}

test("ACP form persistence failure retains the native resolver and retries exactly once", async () => {
  const f = await asking()
  try {
    f.ports.failPersist = true
    expect(await f.owner.broker.answer(f.pending.request.requestId, { kind: "form", values: { answer: "yes" } }, { sessionId: "s1" }))
      .toMatchObject({ ok: false, refusal: "persistence", retryable: true })
    expect(f.owner.broker.list({ sessionId: "s1" })).toEqual([f.pending])
    expect(f.ports.readPending({ sessionId: "s1" })).toEqual([f.pending])
    expect(f.ports.published.map((event) => event.type)).toEqual(["question.asked"])
    expect(f.peer.messages.filter((row) => row.id === "form-wire")).toEqual([])
    expect(f.ports.saved).toEqual([])
    f.ports.failPersist = false
    expect(await f.owner.broker.answer(f.pending.request.requestId, { kind: "form", values: { answer: "yes" } }, { sessionId: "s1" })).toMatchObject({ ok: true })
    expect(await reached(() => f.peer.messages.find((row) => row.id === "form-wire")))
      .toEqual({ jsonrpc: "2.0", id: "form-wire", result: { action: "accept", content: { answer: "yes" } } })
    expect(f.ports.saved.map((row) => row.answer)).toEqual([{ kind: "form", values: { answer: "yes" } }])
    expect(f.ports.readPending({ sessionId: "s1" })).toEqual([])
    expect(f.owner.broker.list({ sessionId: "s1" })).toEqual([])
    expect(await f.owner.broker.answer(f.pending.request.requestId, { kind: "form", values: { answer: "yes" } }, { sessionId: "s1" })).toMatchObject({ ok: false, refusal: "duplicate" })
    expect(f.peer.messages.filter((row) => row.id === "form-wire")).toHaveLength(1)
  } finally { await f.finish() }
})

test("ACP cancellation defeats form validation and duplicate acceptance without consuming a second answer", async () => {
  const f = await asking()
  let release!: () => void
  try {
    f.ports.evaluated = new Promise<void>((resolve) => { release = resolve })
    const validating = f.owner.broker.answer(f.pending.request.requestId, { kind: "form", values: { answer: "yes" } }, { sessionId: "s1" })
    await reached(() => f.ports.evaluatedChecks.length === 2 ? true : undefined)
    await expect(f.owner.broker.answer(f.pending.request.requestId, { kind: "form", values: { answer: "yes" } }, { sessionId: "s1" }))
      .rejects.toMatchObject({ code: "validation_busy" })
    f.controller.abort()
    release()
    expect(await validating).toMatchObject({ ok: false, refusal: "duplicate" })
    expect(await reached(() => f.peer.messages.find((row) => row.id === "form-wire")))
      .toEqual({ jsonrpc: "2.0", id: "form-wire", result: { action: "cancel" } })
    expect(f.ports.evaluatorSignal?.aborted).toBe(true)
    expect(f.ports.saved.map((row) => row.answer)).toEqual([{ kind: "cancelled" }])
    expect(f.ports.readPending({ sessionId: "s1" })).toEqual([])
    expect(f.ports.published.map((event) => event.type)).toEqual(["question.asked"])
  } finally { release?.(); await f.finish() }
})

test("disposing a sibling ACP transport preserves the owner's pending startup form", async () => {
  const f = wireFixture((peer, message) => {
    if (message.method !== "session/new") return false
    peer.elicit("startup-form", { requestId: message.id! })
    return true
  })
  const sibling = new AcpTransport(f.services, { kind: "process", command: "wire-peer" }, filterMcpServers)
  const starting = f.start().then((session) => session, (error: unknown) => error)
  try {
    const pending = await reached(() => f.owner.broker.list({ sessionId: "s1" })[0])
    await sibling.dispose()
    expect(f.owner.broker.list({ sessionId: "s1" })).toEqual([pending])
    expect(f.ports.saved).toEqual([])
    expect(f.peers[0]!.retirements).toBe(0)
    await f.transport.dispose()
    expect(await starting).toBeInstanceOf(Error)
    expect(f.ports.saved.map((row) => row.answer)).toEqual([{ kind: "cancelled" }])
    expect(f.ports.readPending({ sessionId: "s1" })).toEqual([])
    expect(f.ports.bindings.size).toBe(0)
    expect(await f.owner.broker.answer(pending.request.requestId, { kind: "form", values: { answer: "yes" } }, { start: f.binding }))
      .toMatchObject({ ok: false, refusal: "stale" })
  } finally { await sibling.dispose(); await f.transport.dispose() }
})
