import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import type { ForkOperations } from "@claxedo/harness/contract"
import { withWorkspaceTarget } from "../target"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
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
  connections: [{ connectionId: "engine", providerKey: "engine", configRevision: 1, enabled: true, config: {} }],
  defaultHarness: { kind: "connection", connectionId: "engine" },
}

/**
 * A harness that keeps its sessions in its own engine, as OpenCode does: its
 * fork answers the engine's own id for the child, and the child exists for the
 * runtime only once the host has persisted it in its own store.
 */
async function fixture(fork: ForkOperations["fork"]) {
  const directory = await mkdtemp(join(tmpdir(), "runtime-fork-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const target = { workspaceId: "ws_fork", directory }
  const provider = fakeConnectionProvider({ providerKey: "engine", transport: () => new FakeTransport({ fork }) })
  const host = createWorkspaceHost({
    sessionIdWorkspace: () => undefined, placement: loopbackMachineLoginPolicy(), target, storeRoot: join(directory, "state"), connectionProviders: [provider] })
  cleanups.push(() => host.dispose())
  await host.apply(snapshot)
  const app = new Hono()
  host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
  const request = (pathname: string, method = "GET", body?: unknown) => withWorkspaceTarget(target, () => app.request(
    `http://runtime.test${pathname}?directory=${encodeURIComponent(directory)}`,
    { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) },
  ))
  expect((await request("/session", "POST", { id: "parent" })).status).toBe(201)
  return { request, host }
}

test("a fork by a harness that keeps its sessions elsewhere is persisted by the host, then read back under the requested id", async () => {
  const forks: Array<{ parentId: string; messageId: string; childId: string }> = []
  const f = await fixture(async (session, messageId, childId) => {
    forks.push({ parentId: session.binding.sessionId, messageId, childId })
    return { upstreamSessionId: "engine_child" }
  })

  const response = await f.request("/session/parent/fork", "POST", { id: "child", messageId: "msg_1" })

  expect(response.status, await response.clone().text()).toBe(201)
  const forked = await response.json() as { id: string; time: { created: number; updated: number } }
  expect(forked.id).toBe("child")
  expect(forked.time.updated).toBeGreaterThanOrEqual(forked.time.created)
  expect(forks).toEqual([{ parentId: "parent", messageId: "msg_1", childId: "child" }])
  expect(f.host.sessionTime("child")).toEqual(forked.time)
  const read = await f.request("/session/child")
  expect(read.status).toBe(200)
  expect(await read.json()).toMatchObject({ id: "child", time: forked.time })
  expect((await f.request("/session/engine_child")).status).toBe(404)
})
