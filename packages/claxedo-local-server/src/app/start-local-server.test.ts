import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventEmitter } from "node:events"
import { workspaceSupervisorInstalled } from "@claxedo/server-core/workspace/supervisor-port"
import {
  configureOpenCodeWorkerPath,
  drainOpenCodeEngine,
  __setOpenCodeEmbedLoaderForTests,
  opencodeRequest,
  OPENCODE_INTERNAL_BASE,
  __setOpenCodeWorkerForkForTests,
} from "@claxedo/server-core/opencode/engine"
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
  if (previous === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous
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
  test("reports readiness when the listener accepts health requests", async () => {
    const local = await boot()
    await local.ready
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

  test("hands the desktop's engine worker artifact to the engine transport", async () => {
    // The desktop passes `opencodeWorkerPath` from
    // CLAXEDO_CHILD_OPENCODE_WORKER_PATH and hard-throws at launch if the
    // artifact is missing. Until this option was DECLARED here it was silently
    // dropped — a conditional spread at the call site evades TypeScript's
    // excess-property check — so the desktop validated an artifact it never
    // used and the worker transport was dead code.
    //
    // This asserts the option is USED, not merely accepted: the engine
    // transport forks the exact artifact the composition root was handed.
    const worker = new EventEmitter() as EventEmitter & { kill(): boolean }
    worker.kill = () => true
    const forkWorker = vi.fn((..._args: unknown[]) => {
      queueMicrotask(() => worker.emit("message", { type: "claxedo-engine-ready", port: 45123 }))
      return worker as never
    })
    __setOpenCodeWorkerForkForTests(forkWorker as never)
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch
    try {
      const port = await freePort()
      server = startLocalServer({
        port,
        services: createLocalControlPlaneServices(),
        opencodeWorkerPath: "/opt/claxedo/claxedo-engine-worker/index.js",
      })
      await server.ready

      const res = await opencodeRequest(new Request(`${OPENCODE_INTERNAL_BASE}/session`))
      expect(res.status).toBe(200)
      expect(forkWorker).toHaveBeenCalledTimes(1)
      expect(forkWorker.mock.calls[0]?.[0]).toBe("/opt/claxedo/claxedo-engine-worker/index.js")
    } finally {
      globalThis.fetch = realFetch
      await drainOpenCodeEngine()
      __setOpenCodeWorkerForkForTests(undefined)
      configureOpenCodeWorkerPath(undefined)
    }
  })

  test("without the option the engine stays in-process — no worker is forked", async () => {
    // The negative half. Without it, a composition that forked a worker
    // unconditionally would pass the test above, and the option would once
    // again not be the thing deciding the transport.
    const forkWorker = vi.fn((..._args: unknown[]) => {
      throw new Error("a server given no worker path must never fork one")
    })
    __setOpenCodeWorkerForkForTests(forkWorker as never)
    // A stub engine module: without it this test loads the real 23 MB artifact
    // and costs six seconds to prove a negative.
    __setOpenCodeEmbedLoaderForTests(async () => ({
      Server: { Default: () => ({ app: { fetch: async () => Response.json({ inProcess: true }) } }) },
      InstanceRuntime: { disposeAllInstances: async () => {} },
    }) as never)
    try {
      const port = await freePort()
      server = startLocalServer({ port, services: createLocalControlPlaneServices() })
      await server.ready

      const res = await opencodeRequest(new Request(`${OPENCODE_INTERNAL_BASE}/session`))
      expect(await res.json()).toEqual({ inProcess: true })
      expect(forkWorker).not.toHaveBeenCalled()
    } finally {
      await drainOpenCodeEngine()
      __setOpenCodeEmbedLoaderForTests(undefined)
      __setOpenCodeWorkerForkForTests(undefined)
      configureOpenCodeWorkerPath(undefined)
    }
  })

  test("a later server with no worker path is not stuck with an earlier one's", async () => {
    // The option is applied unconditionally, including `undefined`, so it is
    // authoritative for THIS server rather than sticky process state. Without
    // that, a second composition in the same process silently inherits the
    // first one's transport — which is the same class of bug as dropping the
    // option: the option no longer decides.
    const worker = new EventEmitter() as EventEmitter & { kill(): boolean }
    worker.kill = () => true
    const forkWorker = vi.fn((..._args: unknown[]) => {
      queueMicrotask(() => worker.emit("message", { type: "claxedo-engine-ready", port: 45124 }))
      return worker as never
    })
    __setOpenCodeWorkerForkForTests(forkWorker as never)
    __setOpenCodeEmbedLoaderForTests(async () => ({
      Server: { Default: () => ({ app: { fetch: async () => Response.json({ inProcess: true }) } }) },
      InstanceRuntime: { disposeAllInstances: async () => {} },
    }) as never)
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json({ viaWorker: true })) as unknown as typeof fetch
    try {
      const first = startLocalServer({
        port: await freePort(),
        services: createLocalControlPlaneServices(),
        opencodeWorkerPath: "/opt/claxedo/claxedo-engine-worker/index.js",
      })
      await first.ready
      expect(await (await opencodeRequest(new Request(`${OPENCODE_INTERNAL_BASE}/session`))).json())
        .toEqual({ viaWorker: true })
      await first.stop()
      await drainOpenCodeEngine()

      // Same process, new server, no worker path: back to the in-process engine.
      server = startLocalServer({ port: await freePort(), services: createLocalControlPlaneServices() })
      await server.ready
      expect(await (await opencodeRequest(new Request(`${OPENCODE_INTERNAL_BASE}/session`))).json())
        .toEqual({ inProcess: true })
      expect(forkWorker).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.fetch = realFetch
      await drainOpenCodeEngine()
      __setOpenCodeEmbedLoaderForTests(undefined)
      __setOpenCodeWorkerForkForTests(undefined)
      configureOpenCodeWorkerPath(undefined)
    }
  })

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
