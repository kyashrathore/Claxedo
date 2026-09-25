import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { runConformance, setupConformance, type ConformanceBackend } from "./test-support/run"
import { reservePort, releasePort } from "../../e2e/harness/ports"
import { startScriptedCursorBackend } from "../../e2e/harness/cursor/backend"
import { egressProxyEnv, startEgressGuard, unexpectedEgress } from "../../e2e/harness/egress-guard"
import { CursorSdkTransport } from "../transports/cursor-sdk"
import { cursorWorkerEnvironment } from "../transports/cursor-sdk/worker-registry"
import type { HarnessSession, SessionBroker } from "../contract"

type CursorBackend = ConformanceBackend & { env: NodeJS.ProcessEnv; server: Awaited<ReturnType<typeof startScriptedCursorBackend>> }

async function backend(): Promise<CursorBackend> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-conformance-"))
  const directory = path.join(root, "work")
  await fs.mkdir(directory)
  const serverPort = await reservePort()
  const guardPort = await reservePort()
  const server = await startScriptedCursorBackend(serverPort)
  const guard = await startEgressGuard(guardPort)
  server.script("conformance", { steps: [{ kind: "text", text: "PICONFORM" }], usage: { inputTokens: 7, outputTokens: 11 } })
  server.defaultScript("conformance")
  return {
    directory, server, env: { ...process.env, ...egressProxyEnv(guard.url) },
    harness: { id: "cursor", access: "native" }, model: { providerID: "cursor", modelID: "scripted" },
    credentials: { providers: { cursor: { baseUrl: server.url, placeholder: "cursor-conformance-placeholder", authMode: "bearer" } },
      secrets: {}, leaseGeneration: "conformance" },
    owner: { kind: "machine-owner" }, expectedMcp: "session", textCommand: "CURSOR_SCRIPT:conformance",
    close: async () => {
      console.log(`Cursor outbound attempts: ${JSON.stringify(guard.attempts)}`)
      const unexpected = unexpectedEgress(guard.attempts)
      await guard.close()
      await server.close()
      releasePort(serverPort)
      releasePort(guardPort)
      await fs.rm(root, { recursive: true, force: true })
      expect(unexpected).toEqual([])
    },
  }
}

runConformance({
  name: "cursor-sdk",
  backend,
  makeTransport(services, state) { return new CursorSdkTransport(services, (state as CursorBackend).env) },
})

test("keeps the machine owner's endpoint when no binding is selected", () => {
  const env = cursorWorkerEnvironment({ CURSOR_BACKEND_URL: "http://127.0.0.1:49177", CURSOR_API_KEY: "owner-key" })
  expect(env.CURSOR_BACKEND_URL).toBe("http://127.0.0.1:49177")
  expect(env.CURSOR_API_KEY).toBe("owner-key")
  const brokered = cursorWorkerEnvironment(env, "http://127.0.0.1:49178/bindings/cursor")
  expect(brokered.CURSOR_BACKEND_URL).toBe("http://127.0.0.1:49178/bindings/cursor")
  expect(brokered.CURSOR_API_KEY).toBeUndefined()
})

test("an unbound worker sends the SDK turn to the machine owner's endpoint", async () => {
  const state = await backend()
  const unbound = { ...state, credentials: { providers: {}, secrets: {}, leaseGeneration: "owner" } }
  const context = await setupConformance({ name: "machine-owner", backend: async () => unbound,
    makeTransport: (services) => new CursorSdkTransport(services, {
      ...state.env, CURSOR_BACKEND_URL: state.server.url, CURSOR_API_KEY: "owner-placeholder",
    }) })
  try {
    const events = []
    for await (const event of context.transport.send(context.session, context.turn("CURSOR_SCRIPT:conformance"), context.turnBroker())) events.push(event)
    expect(events.some((event) => event.event.type === "finish")).toBe(true)
    expect(state.server.requests.some((request) => request.path === "/agent.v1.AgentService/RunSSE")).toBe(true)
  } finally { await context.close() }
})

test("two bindings use separate SDK module registries", async () => {
  const first = await backend()
  const second = await backend()
  const services = (await import("./test-support/services")).createTestServices()
  const transport = new CursorSdkTransport(services, first.env)
  try {
    const one = await setupConformance({ name: "first", backend: async () => first, makeTransport: () => transport })
    const secondSession = await transport.start({ ...one.start, sessionId: "s2", workspaceId: "w2",
      directory: second.directory, credentials: second.credentials }, { rebind: async () => {} } as unknown as SessionBroker)
    const collect = async (session: HarnessSession) => {
      const events = []
      for await (const event of transport.send(session, one.turn("CURSOR_SCRIPT:conformance"), one.turnBroker())) events.push(event)
      return events
    }
    const [firstEvents, secondEvents] = await Promise.all([collect(one.session), collect(secondSession)])
    expect(firstEvents.some((item) => item.event.type === "finish")).toBe(true)
    expect(secondEvents.some((item) => item.event.type === "finish")).toBe(true)
    expect(first.server.requests.some((request) => request.path === "/agent.v1.AgentService/RunSSE")).toBe(true)
    expect(second.server.requests.some((request) => request.path === "/agent.v1.AgentService/RunSSE")).toBe(true)
  } finally { await transport.dispose(); await first.close(); await second.close() }
}, 60_000)

test.each([
  ["/auth/exchange_user_api_key", true],
  ["/aiserver.v1.DashboardService/GetUserPrivacyMode", false],
  ["/aiserver.v1.ServerConfigService/GetServerConfig", false],
  ["/aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam", false],
  ["/aiserver.v1.AnalyticsService/BootstrapStatsig", false],
  ["/agent.v1.AgentService/RunSSE", true],
] as const)("records whether refusing %s stops a turn", async (path, shouldFail) => {
  const denied = await backend()
  denied.server.refusePath(path, 403)
  let failed = false
  try {
    const context = await setupConformance({ name: "denied", backend: async () => denied,
      makeTransport: (services) => new CursorSdkTransport(services, denied.env) })
    try {
      const events = []
      for await (const event of context.transport.send(context.session, context.turn("CURSOR_SCRIPT:conformance"), context.turnBroker())) events.push(event)
      failed = events.some((event) => event.event.type === "error") || !events.some((event) => event.event.type === "finish")
    } catch { failed = true }
    await context.close()
  } catch { failed = true }
  expect(denied.server.requests.some((request) => request.path === path)).toBe(true)
  expect(failed).toBe(shouldFail)

  const allowed = await backend()
  const context = await setupConformance({ name: "allowed", backend: async () => allowed,
    makeTransport: (services) => new CursorSdkTransport(services, allowed.env) })
  try {
    const events = []
    for await (const event of context.transport.send(context.session, context.turn("CURSOR_SCRIPT:conformance"), context.turnBroker())) events.push(event)
    expect(events.some((event) => event.event.type === "finish")).toBe(true)
    expect(allowed.server.requests.some((request) => request.path === path)).toBe(true)
  } finally { await context.close() }
}, 90_000)

test("a failed scripted run retires its worker and the next turn completes", async () => {
  const state = await backend()
  state.server.script("crash", { steps: [], error: { status: 503, message: "scripted Cursor failure" } })
  const context = await setupConformance({ name: "recovery", backend: async () => state,
    makeTransport: (services) => new CursorSdkTransport(services, state.env) })
  try {
    let failed = false
    try {
      const events = []
      for await (const event of context.transport.send(context.session, context.turn("CURSOR_SCRIPT:crash"), context.turnBroker())) events.push(event)
      failed = events.some((event) => event.event.type === "error") || !events.some((event) => event.event.type === "finish")
    } catch { failed = true }
    expect(failed).toBe(true)
    const recovered = []
    for await (const event of context.transport.send(context.session, context.turn("CURSOR_SCRIPT:conformance"), context.turnBroker())) recovered.push(event)
    expect(recovered.some((event) => event.event.type === "finish")).toBe(true)
    expect(state.server.requests.filter((request) => request.path === "/agent.v1.AgentService/RunSSE").length).toBeGreaterThan(1)
  } finally { await context.close() }
}, 90_000)
