import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/db"
import { workspaceSupervisorInstalled } from "@claxedo/server-core/workspace/supervisor-port"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { startLocalServer, type LocalServer } from "./start-local-server"
import type { LocalAppOptions } from "./local-app"
import { createLocalControlPlaneServices } from "./local-services"

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

function services() {
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
    extensionPolicy: {},
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
  } as unknown as LocalAppOptions["services"]
}

async function boot() {
  const port = await freePort()
  server = startLocalServer({
    port,
    services: services(),
    isCredentialPath: (p) => p.startsWith("/api/claxedo/credentials"),
    corsOrigin: (origin) => origin,
  })
  return server
}

describe("startLocalServer", () => {
  test("listens and answers health over a real socket", async () => {
    const local = await boot()
    const response = await fetch(`http://127.0.0.1:${local.port}/api/claxedo/health`)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, localExecution: true })
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
      isCredentialPath: (p) => p.startsWith("/api/claxedo/credentials"),
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
