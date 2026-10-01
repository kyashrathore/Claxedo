import { expect, test } from "bun:test"
import { createHarnessComposer } from "@claxedo/harness/compose"
import { volatileLaunchOwnership } from "@claxedo/process-ownership/launch"
import { createHarnessServices } from "../harness-services"
import { transportHandle } from "../test-support/host-composition"
import { createHostFixture, LOOPBACK_ORIGIN, MACHINE_OWNER } from "../test-support/host-fixture"

type RpcRequest = { id?: string | number; method: string; params?: { sessionId?: string } }

async function restorationFixture() {
  const port = Number(process.env.CLAXEDO_E2E_PORT_RANGE?.split("-")[1] ?? 0)
  const requests: RpcRequest[] = []
  let release: (() => void) | undefined
  let reached!: () => void
  const restoring = new Promise<void>((resolve) => { reached = resolve })
  let held = true
  const server = Bun.serve({
    hostname: "127.0.0.1", port,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response("WebSocket required", { status: 426 }) },
    websocket: {
      message(ws, data) {
        const request = JSON.parse(String(data)) as RpcRequest
        requests.push(request)
        const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }))
        if (request.method === "initialize") {
          reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } })
        } else if (request.method === "session/resume") {
          release = () => { reply({}); held = false }
          reached()
          if (!held) release()
        } else if (request.method === "session/prompt") {
          ws.send(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
            sessionId: request.params?.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "restored" } },
          } }))
          reply({ stopReason: "end_turn" })
        } else if (request.id !== undefined) reply({})
      },
    },
  })
  const services = createHarnessServices({ ownership: volatileLaunchOwnership(),
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    clock: { now: Date.now, setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>) },
    patternEvaluator: async () => {},
    healthChanged: () => {},
  })
  const unused = () => { throw new Error("Only ACP is composed for restoration") }
  const composer = createHarnessComposer(services, {
    acp: () => ({ missingContext: async () => { throw new Error("A known saved session must resume") } }),
    pi: unused, claude: unused, cursor: unused, codex: unused, opencode: unused,
  })
  const transport = composer.connection({ descriptor: { connectionId: "acp", providerKey: "acp", configRevision: 1, enabled: true,
    config: { label: "Restoration", connection: { kind: "websocket", url: `ws://127.0.0.1:${server.port}` } } },
    expectedRevision: 1, directory: "/repo", secrets: {},
  })
  const harness = { id: "acp", access: "connection" as const }
  const handle = { ...transportHandle(harness, transport), locality: "remote" as const }
  const f = createHostFixture({ transports: { forHarness: async () => handle, composed: () => [handle], onRetire: () => () => {} } })
  f.store.bindSession({ owner: MACHINE_OWNER, sessionId: "saved", workspaceId: "ws", directory: "/repo", connectionId: "connection:acp", upstreamSessionId: "upstream", agentSessionId: "upstream" })
  f.store.updateSessionConfig("saved", { harness, agent: "build", model: { providerID: "acp", modelID: "default" } })
  return {
    ...f, requests, restoring,
    release: () => { held = false; release?.() },
    close: async () => {
      await transport.dispose()
      await f.dispose()
      void server.stop(true)
    },
  }
}

test("simultaneous session options and prompt share one authoritative ACP restoration", async () => {
  const f = await restorationFixture()
  try {
    const options = f.runtime.reads.configOptions({ sessionId: "saved" })
    const prompt = f.runtime.turns.start({ sessionId: "saved", text: "continue", origin: LOOPBACK_ORIGIN })
    await f.restoring
    expect(f.requests.filter((request) => request.method === "session/resume")).toHaveLength(1)
    expect(f.requests.filter((request) => request.method === "session/prompt" && request.params?.sessionId === "upstream")).toHaveLength(0)
    expect(f.store.readTurnAuthority("saved")).toBeUndefined()
    f.release()
    await Promise.all([options, prompt])
    await f.runtime.dispose()
    expect(f.requests.filter((request) => request.method === "session/resume")).toHaveLength(1)
    expect(f.requests.filter((request) => request.method === "session/prompt" && request.params?.sessionId === "upstream")).toHaveLength(1)
    expect(JSON.stringify(f.store.getMessages("saved"))).toContain("restored")
    expect(f.store.readTurnAuthority("saved")).toBeUndefined()
  } finally { f.release(); await f.close() }
})

test("a cold ACP resume deadline refuses the public turn before admission and permits a later retry", async () => {
  const f = await restorationFixture()
  const events: string[] = []
  f.eventHub.subscribeGlobal(({ payload }) => { events.push(payload.type) })
  try {
    await expect(f.runtime.turns.start({ sessionId: "saved", text: "must not submit", origin: LOOPBACK_ORIGIN })).rejects.toThrow("timed out")
    expect(f.requests.filter((request) => request.method === "session/resume")).toHaveLength(1)
    expect(f.requests.filter((request) => request.method === "session/prompt" && request.params?.sessionId === "upstream")).toHaveLength(0)
    expect(f.store.readTurnAuthority("saved")).toBeUndefined()
    expect(f.store.getMessages("saved")).toEqual([])
    expect(events).not.toContain("session.error")
    f.release()
    expect((await f.runtime.turns.start({ sessionId: "saved", text: "retry explicitly", origin: LOOPBACK_ORIGIN })).delivery).toBe("start")
    await f.runtime.dispose()
    expect(f.requests.filter((request) => request.method === "session/resume")).toHaveLength(2)
    expect(f.requests.filter((request) => request.method === "session/prompt" && request.params?.sessionId === "upstream")).toHaveLength(1)
    expect(f.store.getSession("saved")?.status).toBe("idle")
  } finally { f.release(); await f.close() }
}, 15_000)
