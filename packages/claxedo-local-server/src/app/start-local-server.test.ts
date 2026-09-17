import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { customVerifierAuthAdapter, localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import { workspaceSupervisorInstalled } from "@claxedo/server-core/workspace/supervisor-port"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { startLocalServer, type LocalServer } from "./start-local-server"
import type { LocalAppOptions } from "./local-app"
import { createLocalControlPlaneServices } from "./local-services"
import { createLocalDaemonLifecycle } from "./local-daemon-lifecycle"

/**
 * Boots the real server on a real socket and talks to it over HTTP.
 *
 * `createLocalApp`'s tests use `app.request()`, which never opens a port. That
 * cannot tell you whether the listener starts, whether the websocket upgrade is
 * injected, or whether stopping actually releases anything — and a lifecycle
 * wire that silently never runs is the failure mode this file exists for.
 */

let dataDir: string
let previous: string | undefined
let server: LocalServer | undefined

async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (!address || typeof address === "string") {
        probe.close()
        reject(new Error("could not allocate a port"))
        return
      }
      probe.close(() => resolve(address.port))
    })
    probe.on("error", reject)
  })
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-start-local-"))
  previous = process.env.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_DATA_DIR = dataDir
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  // Direct service-composition tests below do not have a LocalServer lifecycle
  // to close the process-owned SQLite connection for them.
  ClaxedoDB.close()
  if (previous === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous
  // Windows cannot delete the data dir while the module-scoped sqlite
  // handles hold files inside it (EPERM/EBUSY); both closes are registry
  // resets, so any later use lazily reopens.
  ClaxedoDB.close()
  closeAuthorityDatabases()
  rmSync(dataDir, { recursive: true, force: true })
})

function services(overrides: Record<string, unknown> = {}) {
  return {
    auth: { config: {} },
    credentials: {
      listCredentials: async () => [],
      getCredentialByProvider: async () => undefined,
      putCredential: async () => ({ id: "cred_1" }),
      deleteCredential: async () => true,
      deleteCredentialsByProvider: async () => 0,
      updateCredentialStatus: async () => {},
      syncLocalCredentials: async () => ({ synced: [], existing: [], missing: [], failed: [] }),
    },
    localExecution: { enabled: true },
    telemetry: { capture: vi.fn() },
    projectionStore: {
      put_session_meta: vi.fn(async () => {}),
      delete_session_meta: vi.fn(async () => {}),
      sync_session_meta: vi.fn(async () => {}),
    },
    relay: {},
    sandbox: {},
    durableSessionLog: {},
    ...overrides,
  } as unknown as LocalAppOptions["services"]
}

async function boot() {
  const port = await freePort()
  server = startLocalServer({
    port,
    services: services(),
    corsOrigin: (origin) => origin,
  })
  return server
}

describe("startLocalServer", () => {
  test("delivers the shutdown acknowledgment before closing the real HTTP connection", async () => {
    const lifecycle = createLocalDaemonLifecycle({
      activity: () => ({
        pty: { running: 0, committed: 0, provisional: 0, managed: 0, subscribers: 0 },
        runtime: { hosts: 0, activeTurns: 0, activeWrites: 0, checkpointing: 0 },
        residencyPins: 0,
        replacementBlockers: 0,
      }),
      onIdle: () => server!.stop(),
    })
    server = startLocalServer({
      port: await freePort(),
      services: services(),
      daemon: {
        identity: { token: "shutdown-test", protocol: 1, generation: "shutdown-test", pid: process.pid },
        lifecycle,
      },
    })
    await server.ready
    lifecycle.start()
    const base = `http://127.0.0.1:${server.port}/api/claxedo/daemon`
    const headers = { authorization: "Bearer shutdown-test", "content-type": "application/json" }
    const acquired = await fetch(`${base}/leases`, { method: "POST", headers })
    expect(acquired.status).toBe(201)
    const lease = await acquired.json() as { id: string }
    const response = await fetch(`${base}/shutdown`, {
      method: "POST", headers, body: JSON.stringify({ leaseId: lease.id }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ shutdownRequested: true, released: true })
    await server.stop()
    await expect(fetch(`${base}/state`, { headers })).rejects.toThrow()
  }, 30_000)

  test("listens and answers health over a real socket", async () => {
    const local = await boot()
    const response = await fetch(`http://127.0.0.1:${local.port}/api/claxedo/health`)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, localExecution: true })
  }, 30_000)

  test("reads the quota view in the signed caller's own org", async () => {
    // The quota reader and the credential routes must resolve one tenant. Given
    // no auth configuration, `requestOrg` answers every signed caller in the
    // single-tenant partition and the plans drawn are another org's.
    const listCredentials = vi.fn(async (_org: string) => [])
    const port = await freePort()
    server = startLocalServer({
      port,
      services: services({
        auth: customVerifierAuthAdapter({
          issuer: "https://idp.example.test",
          verifier: async (token, config) => ({
            mode: "signed" as const,
            user: {
              subject: token,
              tokenIdentifier: `${config.issuer}|${token}`,
              issuer: config.issuer,
              orgId: "org-alpha",
            },
          }),
        }),
        credentials: { listCredentials },
      }),
    })
    await server.ready

    const response = await fetch(`http://127.0.0.1:${port}/api/claxedo/usage?view=quota&since=0&until=86400000`, {
      headers: { Authorization: "Bearer alpha-user" },
    })

    expect(response.status).toBe(200)
    expect(listCredentials).toHaveBeenCalledWith("org-alpha")
  }, 30_000)

  test("ships the unified usage endpoint in the desktop-local composition", async () => {
    const local = await boot()
    expect(local.app.routes.some((route) => route.method === "GET" && route.path === "/api/claxedo/usage")).toBe(true)
    expect(local.app.routes.some((route) => route.method === "POST" && route.path === "/api/claxedo/usage/sync")).toBe(true)
  }, 30_000)

  test("binds loopback only", async () => {
    // A desktop server reachable off-box is the whole network threat model, and
    // the bind address is the control that prevents it. Asserted on the bound
    // address rather than by probing `0.0.0.0`, which on this OS routes to the
    // loopback listener anyway and so cannot distinguish the two.
    const local = await boot()
    expect(local.hostname).toBe("127.0.0.1")
    expect((await fetch(`http://127.0.0.1:${local.port}/api/claxedo/health`)).status).toBe(200)
  }, 30_000)

  test("starts NO workspace supervisor, because this product provisions no cloud", async () => {
    // The omission is the product boundary, so it is asserted rather than
    // assumed. Runtime dispatch reaches the supervisor through a port that
    // correctly no-ops when none is installed.
    await boot()
    expect(workspaceSupervisorInstalled()).toBe(false)
  }, 30_000)

  test("stopping releases the port", async () => {
    const local = await boot()
    const port = local.port
    await local.stop()
    server = undefined

    // The port must be re-bindable, which it is not if the listener leaked.
    await expect(new Promise<void>((resolve, reject) => {
      const probe = createServer()
      probe.once("error", reject)
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()))
    })).resolves.toBeUndefined()
  }, 30_000)

  test("stopping bounds the drain of an open event stream", async () => {
    const local = await boot()
    local.app.get("/api/claxedo/test-shutdown-stream", () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("data: ready\n\n")) },
    }), { headers: { "content-type": "text/event-stream" } }))
    const response = await fetch(`http://127.0.0.1:${local.port}/api/claxedo/test-shutdown-stream`)
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: ready\n\n")
    const disconnected = reader.read().then(() => "ended", () => "disconnected")
    await local.stop()
    expect(await disconnected).toBe("disconnected")
    await expect(fetch(`http://127.0.0.1:${local.port}/api/claxedo/health`)).rejects.toThrow()
  }, 15_000)

  test("stopping bounds the drain of an open event WebSocket", async () => {
    const port = await freePort()
    // The shell's event route is gated by the control-plane route auth, which
    // passes unsigned callers only under the real local-only configuration.
    const local = server = startLocalServer({ port, services: services({ auth: localOnlyAuthAdapter() }) })
    await local.ready
    const socket = new WebSocket(`ws://127.0.0.1:${local.port}/api/cp/events`)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener("error", () => reject(new Error("event WebSocket did not open")), { once: true })
    })
    const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }))
    // The client never closes: an upgraded socket is outside the HTTP server's
    // own connection list, so only the drain deadline can end it.
    await local.stop()
    await closed
    await expect(fetch(`http://127.0.0.1:${local.port}/api/claxedo/health`)).rejects.toThrow()
  }, 15_000)

  // NOT TESTED: that `stop()` is idempotent. The `stopped` guard in the
  // implementation is defensive — removing it does not fail anything here,
  // because a second `server.close()` on a closed listener still invokes its
  // callback and the data-dir release already swallows a double release. A test
  // asserting it would pass either way, which is worse than no test.
})

describe("createLocalControlPlaneServices", () => {
  test("composes a server that answers, with no cloud surface", async () => {
    // The real services, not the fixture above — this is what the desktop entry
    // will pass. Booting on them proves the SQLite session projection, the
    // credential registry and the loopback auth adapter actually compose.
    const port = await freePort()
    server = startLocalServer({
      port,
      services: createLocalControlPlaneServices(),
      corsOrigin: (origin) => origin,
    })

    expect((await fetch(`http://127.0.0.1:${port}/api/claxedo/health`)).status).toBe(200)
    // Unsigned by construction: no account, nothing to verify a bearer against.
    expect((await fetch(`http://127.0.0.1:${port}/api/claxedo/credentials`)).status).toBe(200)
    expect(workspaceSupervisorInstalled()).toBe(false)
  }, 30_000)

  test("records a session into the real projection store", async () => {
    // End to end through the SQLite store the desktop actually uses, rather
    // than a vi.fn() that would pass against a projection that never persists.
    const services = createLocalControlPlaneServices()
    await services.projectionStore.put_session_meta("ses_local_1", {
      directory: "/work",
      title: "Recorded",
    })

    const stored = await services.projectionStore.session_meta("ses_local_1")
    expect(stored).toMatchObject({ sessionID: "ses_local_1", title: "Recorded", directory: "/work" })
  }, 30_000)
})
