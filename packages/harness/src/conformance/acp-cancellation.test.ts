import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { setupConformance } from "./test-support/run"
import { AcpTransport } from "../transports/acp"
import { filterMcpServers } from "../capabilities/mcp-filter"
import { startScriptedAcpWebSocket } from "../../e2e/harness/acp/websocket"
import { writeAcpScript, acpScriptToken, releaseAcpHold } from "../../e2e/harness/acp/script"
import { readAcpRequests } from "../../e2e/harness/acp/requests"
import { pollUntil } from "./test-support/poll"
import { collect, reached, wireFixture } from "./test-support/acp-wire"
import type { RoutedEvent } from "../contract"

test("ACP acknowledged cancellation with a still-open prompt reaches its deadline without claiming terminal, and reads degraded until the turn ends", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acp-cancellation-"))
  const directory = path.join(root, "work")
  await mkdir(directory)
  await writeAcpScript(directory, "held", { steps: [{ kind: "hold", name: "never" }] })
  const server = await startScriptedAcpWebSocket(directory, { holdMethod: "session/cancel" })
  const context = await setupConformance({
    name: "acp-cancellation-stop",
    backend: async () => ({ directory, harness: { id: "acp", access: "connection" }, model: { providerID: "acp", modelID: "default" },
      credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "test" }, owner: { kind: "machine-owner" }, locality: "remote",
      unrunnableTurn: (turn) => turn,
      close: async () => { await server.close(); await rm(root, { recursive: true, force: true }) },
    }),
    makeTransport: (services) => new AcpTransport(services, { kind: "websocket", url: server.url }, filterMcpServers,
      async () => { throw new Error("No handoff in cancellation test") }),
  })
  const stream = context.transport.send(context.session, context.turn(acpScriptToken("held")), context.turnBroker())
  const running = (async () => { for await (const _event of stream) {} })()
  let finished = false
  const drained = running.then(() => { finished = true; return "completed" }, (error: unknown) => { finished = true; return String(error) })
  try {
    expect(await pollUntil(async () => (await readAcpRequests(directory)).some((row) => row.method === "session/prompt") || undefined, Date.now() + 2_000)).toBe(true)
    const health = () => context.transport.health!.runtime(directory, context.session.binding.sessionId)
    expect(health()).toEqual({ status: "ok" })
    const changesBeforeStop = context.services.healthChanges.count
    const startedAt = Date.now()
    const outcome = await context.transport.cancel(context.session, { turnId: "t1", assistantMessageId: "a1" },
      { at: Date.now() + 40, signal: new AbortController().signal })
    expect((await readAcpRequests(directory)).filter((row) => row.method === "session/prompt")).toHaveLength(1)
    expect(outcome).toMatchObject({ execution: "running", cleanup: "unknown", error: { code: "cancellation_timeout" } })
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30)
    expect(finished).toBe(false)
    expect((await readAcpRequests(directory)).filter((row) => row.method === "session/cancel")).toHaveLength(1)
    expect(health()).toMatchObject({ status: "degraded", reason: "harness_process_lost" })
    expect(context.transport.health!.runtime(directory)).toMatchObject({ status: "degraded", reason: "harness_process_lost" })
    expect(context.services.healthChanges.count).toBe(changesBeforeStop + 1)
    await releaseAcpHold(directory, "never")
    expect(await drained).toBe("completed")
    expect(health()).toEqual({ status: "ok" })
    expect(context.services.healthChanges.count).toBe(changesBeforeStop + 2)
    expect(await context.transport.cancel(context.session, { turnId: "t1", assistantMessageId: "a1" },
      { at: Date.now() + 40, signal: new AbortController().signal })).toEqual({ execution: "terminal", cleanup: "unknown" })
  } finally { await context.close(); await drained }
})

test("ACP never submits a prompt whose turn was stopped while its configuration was still being applied", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acp-startup-stop-"))
  const directory = path.join(root, "work")
  await mkdir(directory)
  await writeAcpScript(directory, "startup", { steps: [{ kind: "text", text: "must not run" }] })
  const server = await startScriptedAcpWebSocket(directory, { gate: { method: "session/set_config_option", name: "configuring" } })
  const context = await setupConformance({
    name: "acp-startup-stop",
    backend: async () => ({ directory, harness: { id: "acp", access: "connection" }, model: { providerID: "acp", modelID: "default" },
      credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "test" }, owner: { kind: "machine-owner" }, locality: "remote",
      unrunnableTurn: (turn) => turn,
      close: async () => { await server.close(); await rm(root, { recursive: true, force: true }) },
    }),
    makeTransport: (services) => new AcpTransport(services, { kind: "websocket", url: server.url }, filterMcpServers,
      async () => { throw new Error("No handoff in cancellation test") }),
  })
  const stop = new AbortController()
  const turn = context.turn(acpScriptToken("startup"))
  const events: unknown[] = []
  const drained = (async () => {
    for await (const routed of context.transport.send(context.session, { ...turn, prompt: { ...turn.prompt, permissionMode: "review" } }, context.turnBroker(stop.signal))) events.push(routed.event)
  })().then(() => "completed", (error: unknown) => String(error))
  try {
    expect(await pollUntil(async () => (await readAcpRequests(directory)).some((row) => row.method === "session/set_config_option") || undefined, Date.now() + 2_000)).toBe(true)
    stop.abort()
    expect(await context.transport.cancel(context.session, { turnId: "t1", assistantMessageId: "a1" },
      { at: Date.now() + 2_000, signal: new AbortController().signal })).toEqual({ execution: "unknown", cleanup: "unknown" })
    await releaseAcpHold(directory, "configuring")
    expect(await drained).toBe("completed")
    expect((await readAcpRequests(directory)).filter((row) => row.method === "session/prompt")).toEqual([])
    expect(events).toEqual([{ type: "session-status", status: "idle" }, { type: "cancelled", sessionId: "s1" }])
  } finally { await releaseAcpHold(directory, "configuring"); await drained; await context.close() }
})

test("ACP quiet expiry fails the turn once, drops the provider's late output and keeps the session fenced after it settles", async () => {
  const f = wireFixture((_peer, message) => message.method === "session/prompt", { promptTimeoutMs: 35 })
  try {
    const session = await f.start()
    const events: RoutedEvent[] = []
    const running = (async () => { for await (const routed of f.transport.send(session, f.turn, f.turnBroker())) events.push(routed) })()
      .then(() => "completed", (error: unknown) => error)
    const peer = f.peers[0]!
    const prompt = await reached(() => peer.messages.find((row) => row.method === "session/prompt"))
    peer.text(session.binding.upstreamSessionId, "before silence")
    await reached(() => peer.messages.find((row) => row.method === "session/cancel"))
    peer.text(session.binding.upstreamSessionId, "after expiry")
    peer.reply(prompt, { stopReason: "end_turn" })
    expect(await running).toMatchObject({ code: "session", detail: { acpOutcome: "uncertain" }, cause: { code: "timeout" } })
    await expect(collect(f.transport.send(session, f.turn, f.turnBroker()))).rejects.toThrow("outcome is uncertain")
    expect(await f.transport.cancel(session, { turnId: "t1", assistantMessageId: "a1" }, { at: Date.now() + 1_000, signal: new AbortController().signal }))
      .toEqual({ execution: "unknown", cleanup: "unknown" })
    expect(await f.transport.configure(session, { credentials: { ...f.input.credentials, leaseGeneration: "g2" } }))
      .toEqual({ state: "refused", reason: "ACP session outcome is uncertain" })
    const text = events.flatMap(({ event }) => event.type === "text-delta" ? [event.delta] : [])
    expect(text.join("")).toBe("before silence")
    expect(events.some(({ event }) => event.type === "finish" || event.type === "cancelled")).toBe(false)
    expect(peer.messages.filter((row) => row.method === "session/cancel")).toHaveLength(1)
    expect(peer.messages.filter((row) => row.method === "session/prompt")).toHaveLength(1)
  } finally { await f.transport.dispose() }
})
