import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import type { BackgroundTaskOperations, BackgroundTaskRef, HarnessSession, SessionBroker } from "@claxedo/harness/contract"
import { withWorkspaceTarget } from "../target"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { createRuntimeEventHub } from "../projection/runtime-event-hub"
import { FakeTransport, fakeConnectionProvider } from "../test-support/fake-transport"
import { loopbackMachineLoginPolicy } from "../testing"
import { createWorkspaceHost } from "./runtime"
import type { RuntimeSnapshot } from "../routes/config"

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const snapshot: RuntimeSnapshot = {
  version: 4, commands: [], mcp: {}, auth: { machineOwnerUserId: "local", accounts: { local: {} } },
  connections: [{ connectionId: "scripted", providerKey: "scripted", configRevision: 1, enabled: true, config: {} }],
  defaultHarness: { kind: "connection", connectionId: "scripted" },
}

async function fixture(backgroundTasks?: BackgroundTaskOperations) {
  const directory = await mkdtemp(join(tmpdir(), "background-work-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const target = { workspaceId: "ws_background", directory }
  const brokers: SessionBroker[] = []
  const transport: FakeTransport = new FakeTransport({
    ...(backgroundTasks ? { backgroundTasks } : {}),
    beforeStart: async (_input, broker) => { brokers.push(broker) },
    turn: async function* ({ session }) {
      yield { type: "text-delta", delta: "started a background shell" }
      if (transport.turns.length === 1) await brokers[0]!.publish({ type: "background-work", active: true })
      yield { type: "finish", sessionId: session.binding.sessionId }
    },
  })
  const eventHub = createRuntimeEventHub()
  const frames: Array<{ type: string; properties: unknown }> = []
  eventHub.subscribeGlobal(({ payload }) => {
    if (payload.type === "session.background-work" || payload.type === "session.status") frames.push({ type: payload.type, properties: payload.properties })
  })
  const provider = fakeConnectionProvider({ providerKey: "scripted", transport: () => transport })
  const host = createWorkspaceHost({ placement: loopbackMachineLoginPolicy(), target, eventHub, storeRoot: join(directory, "state"), connectionProviders: [provider] })
  cleanups.push(() => host.dispose())
  await host.apply(snapshot)
  const app = new Hono()
  host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
  const request = (pathname: string, method = "GET", body?: unknown) => withWorkspaceTarget(target, () => app.request(
    `http://runtime.test${pathname}${pathname.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`,
    { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) },
  ))
  const prompt = (text: string, session = "s") => request(`/session/${session}/message`, "POST", { parts: [{ type: "text", text }] })
  const stopTask = async (body: unknown, session = "s") => {
    const response = await request(`/session/${session}/background-task/stop`, "POST", body)
    return { status: response.status, body: await response.json() }
  }
  const capabilities = async () => ((await (await request("/session/s/capabilities")).json()) as { backgroundTasks?: unknown }).backgroundTasks
  const statuses = async () => (await request("/session/status")).json()
  const openStatus = async () => ((await (await request("/session/s?view=open")).json()) as { status: unknown }).status
  expect((await request("/session", "POST", { id: "s" })).status).toBe(201)
  return { transport, brokers, frames, prompt, statuses, openStatus, stopTask, capabilities, request }
}

test("background work started in a turn outlives it as a status fact that never holds the next prompt", async () => {
  const f = await fixture()
  expect((await f.prompt("run it in the background")).status).toBe(200)

  expect(await f.statuses()).toEqual({ s: { type: "idle", backgroundWork: true } })
  expect(await f.openStatus()).toEqual({ value: { type: "idle", backgroundWork: true } })

  expect((await f.prompt("what else?")).status).toBe(200)
  expect(f.transport.turns).toHaveLength(2)
  expect(f.transport.turns[1]!.session).toBe(f.transport.turns[0]!.session)
  expect(await f.statuses()).toEqual({ s: { type: "idle", backgroundWork: true } })

  await f.brokers[0]!.publish({ type: "background-work", active: true })
  await f.brokers[0]!.publish({ type: "background-work", active: false })
  expect(await f.statuses()).toEqual({})
  expect(await f.openStatus()).toEqual({ value: null })
  expect(f.frames.filter((frame) => frame.type === "session.background-work")).toEqual([
    { type: "session.background-work", properties: { sessionID: "s", active: true } },
    { type: "session.background-work", properties: { sessionID: "s", active: false } },
  ])
})

test("stopping one background task reaches the attached session's harness by the call that started it, and answers as the harness does", async () => {
  const stops: Array<{ session: HarnessSession; task: BackgroundTaskRef }> = []
  const f = await fixture({ stop: async (session, task) => {
    stops.push({ session, task })
    return task.toolCallId === "call-agent" ? { ok: true } : { ok: false, status: "not_found", message: `No running background task for ${task.toolCallId}` }
  } })
  expect(await f.capabilities()).toBe(true)
  expect((await f.prompt("run it in the background")).status).toBe(200)

  expect(await f.stopTask({ toolCallId: "call-agent" })).toEqual({ status: 200, body: { ok: true } })
  expect(stops.map(({ session, task }) => [session, task])).toEqual([[f.transport.turns[0]!.session, { toolCallId: "call-agent" }]])
  expect(await f.stopTask({ toolCallId: "call-gone" })).toEqual({ status: 404, body: { ok: false, status: "not_found", message: "No running background task for call-gone" } })
  expect((await f.stopTask({})).status).toBe(400)
})

test("a harness without the operation refuses it as unsupported and says so in its capabilities", async () => {
  const f = await fixture()
  expect(await f.capabilities()).toBe(false)
  expect((await f.prompt("run it in the background")).status).toBe(200)
  expect(await f.stopTask({ toolCallId: "call-agent" })).toMatchObject({ status: 409, body: { error: { code: "unsupported_operation", capability: "backgroundTasks" } } })
})
