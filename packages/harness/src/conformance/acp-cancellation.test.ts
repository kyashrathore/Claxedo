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

test("ACP acknowledged cancellation with a still-open prompt reaches its deadline without claiming terminal", async () => {
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
    const startedAt = Date.now()
    const outcome = await context.transport.cancel(context.session, { turnId: "t1", assistantMessageId: "a1" },
      { at: Date.now() + 40, signal: new AbortController().signal })
    expect((await readAcpRequests(directory)).filter((row) => row.method === "session/prompt")).toHaveLength(1)
    expect(outcome).toMatchObject({ execution: "running", cleanup: "unknown", error: { code: "cancellation_timeout" } })
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30)
    expect(finished).toBe(false)
    expect((await readAcpRequests(directory)).filter((row) => row.method === "session/cancel")).toHaveLength(1)
    await releaseAcpHold(directory, "never")
    expect(await drained).toBe("completed")
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
