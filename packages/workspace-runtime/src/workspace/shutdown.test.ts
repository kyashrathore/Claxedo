import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { FakeTransport, fakeConnectionProvider } from "../test-support/fake-transport"
import { createHostFixture, sessionCreate, tick, transportsById, until } from "../test-support/host-fixture"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { withWorkspaceTarget } from "../target"
import { loopbackMachineLoginPolicy } from "../testing"
import { createWorkspaceHost } from "./runtime"
import { createWorkspaceRuntimeApp } from "../server"

async function fixture(transport: FakeTransport) {
  const directory = await mkdtemp(join(tmpdir(), "attachment-shutdown-"))
  const target = { directory, workspaceId: "ws" }
  const host = createWorkspaceHost({ target, placement: loopbackMachineLoginPolicy(), storeRoot: join(directory, "store"),
    harnessStateRoot: join(directory, "harness"), connectionProviders: [fakeConnectionProvider({ providerKey: "fixture", transport: () => transport })] })
  const app = new Hono()
  host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
  await host.apply({ version: 4, auth: {}, mcp: {}, connections: [
    { connectionId: "connection", providerKey: "fixture", configRevision: 1, enabled: true, config: {} },
  ], defaultHarness: { kind: "connection", connectionId: "connection" } })
  return { host, app, target, create: () => withWorkspaceTarget(target, () => app.request("/session", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "starting" }),
  })), cleanup: () => rm(directory, { recursive: true, force: true }) }
}

test("workspace shutdown retries failed transport cleanup before closing its store", async () => {
  let attempts = 0
  const f = await fixture(new FakeTransport({ onDispose: () => {
    if (++attempts === 1) throw new Error("cleanup failed")
  } }))
  try {
    expect((await f.create()).status).toBe(201)
    await expect(f.host.dispose()).rejects.toThrow("disposal failed")
    await f.host.dispose()
    expect(attempts).toBe(2)
  } finally { await f.cleanup() }
})

test("public app disposal retries the host and cleans contributions once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-shutdown-"))
  let attempts = 0
  let cleanups = 0
  const transport = new FakeTransport({ onDispose: () => {
    if (++attempts === 1) throw new Error("cleanup failed")
  } })
  const target = { directory, workspaceId: "ws" }
  const runtime = createWorkspaceRuntimeApp({ target, exposure: loopbackWorkspaceRuntimeExposure(),
    placement: loopbackMachineLoginPolicy(), storeRoot: join(directory, "store"), harnessStateRoot: join(directory, "harness"),
    connectionProviders: [fakeConnectionProvider({ providerKey: "fixture", transport: () => transport })],
    routeContributions: [{ id: "cleanup", mount: () => ({ path: "/", routes: new Hono(), dispose: () => { cleanups++ } }) }],
  })
  try {
    await runtime.host.apply({ version: 4, auth: {}, mcp: {}, connections: [
      { connectionId: "connection", providerKey: "fixture", configRevision: 1, enabled: true, config: {} },
    ], defaultHarness: { kind: "connection", connectionId: "connection" } })
    expect((await withWorkspaceTarget(target, () => runtime.app.request("/session", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "created" }),
    }))).status).toBe(201)
    await expect(runtime.dispose()).rejects.toThrow("disposal failed")
    await runtime.dispose()
    expect(attempts).toBe(2)
    expect(cleanups).toBe(1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("shutdown cancels an unanswered startup interaction before waiting for the create request", async () => {
  let release!: () => void
  const released = new Promise<void>((resolve) => { release = resolve })
  const transport = new FakeTransport({ beforeStart: async (_input, broker) => {
    await Promise.race([released, broker.ask({ kind: "question", requestId: "startup-question", question: { id: "startup-question", sessionID: "starting", questions: [
      { header: "Start", question: "Ready?", options: [{ label: "Yes", description: "Start" }] },
    ] } })])
  } })
  const f = await fixture(transport)
  const creating = f.create()
  try {
    await until(() => transport.activeStarts === 1)
    await tick()
    let done = false
    const shutdown = f.host.dispose().then(() => { done = true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const cancelled = done
    release()
    await creating
    await shutdown
    expect(cancelled).toBe(true)
  } finally { release(); await creating; await f.host.dispose(); await f.cleanup() }
})

test("a scrub whose transport would not stop detaches the engine, the next turn runs fresh, and shutdown retries the failed one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scrub-retire-"))
  const target = { directory, workspaceId: "ws" }
  const transports: FakeTransport[] = []
  let firstAttempts = 0
  const host = createWorkspaceHost({ target, placement: loopbackMachineLoginPolicy(), storeRoot: join(directory, "store"),
    harnessStateRoot: join(directory, "harness"), connectionProviders: [fakeConnectionProvider({ providerKey: "fixture", transport: () => {
      const transport = new FakeTransport({ onDispose: () => {
        if (transport === transports[0] && ++firstAttempts === 1) throw new Error("would not stop")
      } })
      transports.push(transport)
      return transport
    } })] })
  const app = new Hono()
  host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
  const request = (path: string, body: unknown) => withWorkspaceTarget(target, () => app.request(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }))
  const snapshot = { version: 4 as const, auth: {}, mcp: {}, connections: [
    { connectionId: "connection", providerKey: "fixture", configRevision: 1, enabled: true, config: {} },
  ], defaultHarness: { kind: "connection" as const, connectionId: "connection" } }
  try {
    await host.apply(snapshot)
    expect((await request("/session", { id: "scrubbed" })).status).toBe(201)
    expect(await host.checkpoint.freeze("drain")).toMatchObject({ state: "frozen" })
    await expect(host.checkpoint.scrub()).rejects.toThrow("disposal failed")
    await host.checkpoint.resume()
    await host.apply(snapshot)
    expect((await request("/session/scrubbed/message", { parts: [{ type: "text", text: "after scrub" }] })).status).toBe(200)
    expect(transports).toHaveLength(2)
    expect(transports[1].turns).toHaveLength(1)
    expect(firstAttempts).toBe(1)
    await host.dispose()
    expect(firstAttempts).toBe(2)
    expect(transports[1].disposed).toBe(true)
  } finally { await host.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test("a runtime whose stop failed is stopped again by its next dispose", async () => {
  let stopping = false
  let refusals = 1
  let checks = 0
  const resolver = transportsById({ pi: new FakeTransport() })
  const host = createHostFixture({ transports: {
    composed: () => resolver.composed(),
    async forHarness(harness, directory, access) {
      const handle = await resolver.forHarness(harness, directory, access)
      return { ...handle, retired: () => {
        if (!stopping) return false
        checks++
        if (refusals-- > 0) throw new Error("stop failed")
        return false
      } }
    },
  } })
  try {
    await host.runtime.sessions.create(sessionCreate({ id: "stopped" }))
    stopping = true
    expect(await host.runtime.dispose()).toMatchObject({ ok: false, error: new Error("stop failed") })
    expect(await host.runtime.dispose()).toEqual({ ok: true })
    expect(checks).toBe(2)
  } finally { stopping = false; await host.dispose() }
})
