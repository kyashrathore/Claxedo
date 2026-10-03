import { installFakePiRpc } from "./test-support/home/fake-pi-rpc.mjs"
import { createWorkspaceRuntimeClient } from "./client"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { serve } from "@hono/node-server"
import type { RelayHostAuthOptions } from "./workspace-host-service-auth"
import { WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER, type WorkspaceRuntimeManagementAuth } from "./management-auth"
import {
  assertWorkspaceRuntimeListenPolicy,
  createWorkspaceRuntimeApp,
  createWorkspaceRuntimeShutdownHandler,
  DEFAULT_WORKSPACE_RUNTIME_HOSTNAME,
  drainWorkspaceRuntime,
  isLoopbackHostname,
  startServer,
  waitForWorkspaceRuntimeServerPort,
  workspaceRuntimeCorsOrigin,
  workspaceRuntimeRouteAuthBoundary,
  workspaceRuntimeListenHostname,
  workspaceRuntimeServiceExposureFromEnv,
  type WorkspaceRuntimeServerOptions,
} from "./server"
import { Pty } from "./pty/index"
import { withSessionCore } from "./session-context"
import { testSessionCore } from "@claxedo/session-core/testing"
import {
  embeddedWorkspaceRuntimeExposure,
  loopbackWorkspaceRuntimeExposure,
  privateNetworkWorkspaceRuntimeExposure,
  relayWorkspaceRuntimeExposure,
} from "./exposure"
import { runtimeEnvText, workspaceRuntimeDataDir } from "./env"
import { managedWorkspaceSessionAccessPolicy, type SessionAccessPolicy } from "@claxedo/session-core"
import {
  configTokenFromEnv,
  hostTunnelFromEnv,
  managementTargetFromEnv,
} from "./workspace-relay-env"
import { volatileLaunchOwnership } from "@claxedo/process-ownership/launch"
import { loopbackMachineLoginPolicy } from "./testing"
import { openSqliteDatabase } from "./sqlite/node"
import { openRuntimeStore } from "./store-file"
import { workspaceStorageRoot } from "./worktree"

/** This suite asserts routing, not recovery: the launch records die with the test. */
const ownership = volatileLaunchOwnership()
const placement = loopbackMachineLoginPolicy()

const relayHostAuth: RelayHostAuthOptions = {
  key: new Uint8Array([1]),
  workspaceId: "ws_1",
  hostId: "host_1",
}

const tempWorkspaceDirs: string[] = []
const originalWorkspaceDirectory = process.env.WORKSPACE_RUNTIME_DIRECTORY

/**
 * Pin the runtime to a throwaway workspace directory.
 *
 * A successful `POST /api/wr/config` persists
 * `.workspace-runtime/runtime-config/{accepted-snapshot,apply-status}.json`
 * into the workspace directory. `workspaceDir()` falls back to `process.cwd()`
 * when nothing is configured, which under `bun test` is the package root — so
 * an unpinned apply rewrites tracked files in the repo on every run.
 */
async function pinTempWorkspaceDirectory() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-server-workspace-"))
  tempWorkspaceDirs.push(dir)
  process.env.WORKSPACE_RUNTIME_DIRECTORY = dir
  return dir
}

afterEach(async () => {
  if (originalWorkspaceDirectory === undefined) delete process.env.WORKSPACE_RUNTIME_DIRECTORY
  else process.env.WORKSPACE_RUNTIME_DIRECTORY = originalWorkspaceDirectory
  await Promise.all(
    tempWorkspaceDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  )
})

const managementToken = "allow-runtime-config"
const managementAuth: WorkspaceRuntimeManagementAuth = {
  authorize: async (input) =>
    input.request.headers.get(WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER) === managementToken
      ? { ok: true, subject: "server-test", scopes: [input.action] }
      : {
          ok: false,
          status: 401,
          code: "runtime_management_token_required",
          message: "Workspace runtime management token is required",
        },
}

async function expectWebSocketOpenFailure(url: string) {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url)
    const timeout = setTimeout(() => reject(new Error("WebSocket rejection timed out")), 3_000)
    ws.onopen = () => {
      clearTimeout(timeout)
      ws.close()
      reject(new Error("WebSocket unexpectedly opened"))
    }
    ws.onerror = () => {
      clearTimeout(timeout)
      resolve()
    }
  })
}

describe("workspace runtime listen policy", () => {
  test("defaults to loopback", () => {
    expect(workspaceRuntimeListenHostname({})).toBe(DEFAULT_WORKSPACE_RUNTIME_HOSTNAME)
    expect(workspaceRuntimeListenHostname({ WORKSPACE_RUNTIME_HOST: "  " })).toBe(DEFAULT_WORKSPACE_RUNTIME_HOSTNAME)
  })

  test("uses explicit listen host when configured", () => {
    expect(workspaceRuntimeListenHostname({ WORKSPACE_RUNTIME_HOST: "0.0.0.0" })).toBe("0.0.0.0")
    expect(workspaceRuntimeListenHostname({ WORKSPACE_RUNTIME_HOST: " ::1 " })).toBe("::1")
  })

  test("classifies loopback hosts", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true)
    expect(isLoopbackHostname("localhost")).toBe(true)
    expect(isLoopbackHostname("::1")).toBe(true)
    expect(isLoopbackHostname("[::1]")).toBe(true)
    expect(isLoopbackHostname("0.0.0.0")).toBe(false)
    expect(isLoopbackHostname("::")).toBe(false)
    expect(isLoopbackHostname("192.168.1.10")).toBe(false)
  })

  test("allows unauthenticated loopback listeners", () => {
    expect(() => assertWorkspaceRuntimeListenPolicy({ sessionIdWorkspace: () => undefined, placement }, "127.0.0.1", { })).not.toThrow()
    expect(() => assertWorkspaceRuntimeListenPolicy({ sessionIdWorkspace: () => undefined, placement, configToken: "cfg-secret" }, "localhost", { })).not.toThrow()
  })

  test("rejects unauthenticated non-loopback listeners", () => {
    expect(() => assertWorkspaceRuntimeListenPolicy({ sessionIdWorkspace: () => undefined, placement }, "0.0.0.0", { })).toThrow(
      "Refusing to listen on non-loopback host 0.0.0.0 without relay-host auth",
    )
  })

  test("does not treat config tokens as whole-server auth", () => {
    expect(() => assertWorkspaceRuntimeListenPolicy({ sessionIdWorkspace: () => undefined, placement, configToken: "cfg-secret" }, "0.0.0.0", { })).toThrow(
      "Refusing to listen on non-loopback host 0.0.0.0 without relay-host auth",
    )
  })

  test("allows relay-authenticated non-loopback listeners", () => {
    expect(() => assertWorkspaceRuntimeListenPolicy({ sessionIdWorkspace: () => undefined, placement, relayHostAuth }, "0.0.0.0", { })).not.toThrow()
  })

  test("allows guarded private-network non-loopback listeners", () => {
    const exposure = privateNetworkWorkspaceRuntimeExposure({
      name: "test-private-network",
      guard: () => true,
      runtimeAuth: () => true,
    })
    expect(() =>
      assertWorkspaceRuntimeListenPolicy({ sessionIdWorkspace: () => undefined, placement,
        exposure,
      }, "0.0.0.0", {})
    ).not.toThrow()
    expect(workspaceRuntimeRouteAuthBoundary({ exposure }, "0.0.0.0", { })).toBe("private-network-host-guard")
  })

  test("allows explicitly exempted private-network listeners", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(() => assertWorkspaceRuntimeListenPolicy({ sessionIdWorkspace: () => undefined, placement }, "0.0.0.0", { WORKSPACE_RUNTIME_ALLOW_UNAUTHENTICATED_NON_LOOPBACK: "1",
      })).not.toThrow()
      expect(warn).toHaveBeenCalledWith(
        "[workspace-runtime] WARN  allowing unauthenticated non-loopback listen because WORKSPACE_RUNTIME_ALLOW_UNAUTHENTICATED_NON_LOOPBACK=1",
      )
    } finally {
      warn.mockRestore()
    }
  })
})

describe("a store this build refuses", () => {
  async function refusedStore() {
    const directory = await pinTempWorkspaceDirectory()
    const storeRoot = path.join(directory, ".state")
    openRuntimeStore(storeRoot).close()
    const other = openSqliteDatabase(path.join(storeRoot, "state.db"))
    other.exec("UPDATE runtime_store_schema SET identity = 'CREATE TABLE session (id TEXT PRIMARY KEY)'")
    other.close()
    return { directory, storeRoot }
  }

  test("still lets the runtime start, and answers every store-backed route with the typed refusal before any work", async () => {
    const { directory, storeRoot } = await refusedStore()
    const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement,
      exposure: loopbackWorkspaceRuntimeExposure(),
      target: { workspaceId: "ws_refused", directory },
      storeRoot,
    })
    try {
      for (const [method, pathname, body] of [
        ["GET", "/api/wr/worktrees", undefined],
        ["POST", "/api/wr/worktrees", { sessionId: "ses_refused" }],
        ["POST", "/api/wr/checkpoint/flush", {}],
        ["POST", "/api/wr/checkpoint/restore-reconcile", { epoch: 1, checkpointId: "checkpoint-1" }],
        ["GET", "/session", undefined],
      ] as const) {
        const response = await runtime.app.request(`http://localhost${pathname}?directory=${encodeURIComponent(directory)}`, {
          method,
          ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
        })
        const label = `${method} ${pathname}`
        expect(response.status, label).toBe(503)
        expect(await response.json(), label).toMatchObject({ error: { code: "runtime_store_schema_mismatch" } })
      }
      expect(fs.existsSync(workspaceStorageRoot("ws_refused"))).toBe(false)
    } finally {
      await runtime.host.dispose()
    }
  })

  test("mounting with a native default harness leaves queued-prompt recovery for an admitted store", async () => {
    const { directory, storeRoot } = await refusedStore()
    const rejections: unknown[] = []
    const record = (reason: unknown) => { rejections.push(reason) }
    process.on("unhandledRejection", record)
    try {
      const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement,
        exposure: loopbackWorkspaceRuntimeExposure(),
        target: { workspaceId: "ws_refused_native", directory },
        storeRoot,
        harness: { kind: "native", harnessId: "pi" },
      })
      try {
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(rejections).toEqual([])
        expect((await runtime.app.request(`http://localhost/session?directory=${encodeURIComponent(directory)}`)).status).toBe(503)
      } finally {
        await runtime.host.dispose()
      }
    } finally {
      process.off("unhandledRejection", record)
    }
  })
})

describe("a composition's own session reads", () => {
  test("read every session of the runtime's store, a worktree's included, and its status, without a caller", async () => {
    const directory = await pinTempWorkspaceDirectory()
    let reads: Parameters<NonNullable<WorkspaceRuntimeServerOptions["bindSessionReads"]>>[0] | undefined
    const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
      placement,
      exposure: loopbackWorkspaceRuntimeExposure(),
      target: { workspaceId: "ws_reads", directory },
      storeRoot: path.join(directory, ".state"),
      bindSessionReads: (bound) => { reads = bound },
    })
    try {
      if (!reads) throw new Error("the runtime bound no session reads")
      const store = reads.store()
      store.bindSession({ owner: { kind: "machine-owner" }, sessionId: "ses_reads", workspaceId: "ws_reads", directory, agentSessionId: "agent_reads" })
      store.markSessionInterrupted("ses_reads")
      const worktree = path.join(directory, ".worktrees", "ses_tree")
      store.bindSession({ owner: { kind: "machine-owner" }, sessionId: "ses_tree", workspaceId: "ws_reads", directory: worktree, agentSessionId: "agent_tree" })
      store.markSessionInterrupted("ses_tree")

      const route = await runtime.app.request(`http://localhost/session/status?directory=${encodeURIComponent(directory)}`)
      expect(reads.store().listSessions(directory).map((session) => session.id)).toEqual(["ses_reads"])
      expect(reads.store().listEverySession().map((session) => session.id).sort()).toEqual(["ses_reads", "ses_tree"])
      expect(await route.json()).toEqual({ ses_reads: expect.objectContaining({ type: "interrupted" }) })
      expect(reads.sessionStatus()).toMatchObject({ ses_reads: { type: "interrupted" }, ses_tree: { type: "interrupted" } })
    } finally {
      await runtime.host.dispose()
    }
  })
})

describe("disposing a runtime", () => {
  test("hands its host the sessions' final state before the store closes", async () => {
    const directory = await pinTempWorkspaceDirectory()
    let reads: Parameters<NonNullable<WorkspaceRuntimeServerOptions["bindSessionReads"]>>[0] | undefined
    const seen: string[][] = []
    const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
      placement,
      exposure: loopbackWorkspaceRuntimeExposure(),
      target: { workspaceId: "ws_close", directory },
      storeRoot: path.join(directory, ".state"),
      bindSessionReads: (bound) => { reads = bound },
      beforeStoreClose: async () => { seen.push(reads!.store().listEverySession().map((session) => session.id)) },
    })
    reads!.store().bindSession({ owner: { kind: "machine-owner" }, sessionId: "ses_close", workspaceId: "ws_close", directory, agentSessionId: "agent_close" })

    await runtime.host.dispose()

    expect(seen).toEqual([["ses_close"]])
  })
})

describe("workspace runtime host route auth", () => {
  test("private-network exposure runs host guard before runtime auth", async () => {
    const seen: string[] = []
    const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement,
      exposure: privateNetworkWorkspaceRuntimeExposure({
        name: "test-private-network",
        guard: (input) => {
          seen.push(`guard:${input.method} ${input.path}`)
          return true
        },
        runtimeAuth: (input) => {
          seen.push(`auth:${input.method} ${input.path}`)
          return false
        },
      }),
    })
    try {
      const response = await runtime.app.request("http://localhost/api/wr/capabilities")

      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({
        error: {
          code: "workspace_runtime_auth_denied",
          message: "Workspace runtime auth denied the request",
        },
      })
      expect(seen).toEqual([
        "guard:GET /api/wr/capabilities",
        "auth:GET /api/wr/capabilities",
      ])
    } finally {
      await runtime.host.dispose()
    }
  })

  test("embedded exposure runs the caller-owned guard before runtime routes", async () => {
    const seen: string[] = []
    const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement,
      exposure: embeddedWorkspaceRuntimeExposure({
        owner: "test",
        guard: (input) => {
          seen.push(`${input.method} ${input.path}`)
          return false
        },
      }),
    })
    try {
      const response = await runtime.app.request("http://localhost/api/wr/health")

      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({
        error: {
          code: "workspace_runtime_exposure_denied",
          message: "Workspace runtime exposure guard denied the request",
        },
      })
      expect(seen).toEqual(["GET /api/wr/health"])
    } finally {
      await runtime.host.dispose()
    }
  })

  test("private-network exposure protects SSE runtime event streams", async () => {
    const seen: string[] = []
    const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement,
      exposure: privateNetworkWorkspaceRuntimeExposure({
        name: "test-private-network",
        guard: (input) => {
          seen.push(`guard:${input.method} ${input.path}`)
          return true
        },
        runtimeAuth: (input) => {
          seen.push(`auth:${input.method} ${input.path}`)
          return false
        },
      }),
    })
    try {
      for (const route of ["/api/wr/events"]) {
        const response = await runtime.app.request(`http://localhost${route}`)

        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({
          error: {
            code: "workspace_runtime_auth_denied",
            message: "Workspace runtime auth denied the request",
          },
        })
      }
      expect(seen).toEqual([
        "guard:GET /api/wr/events",
        "auth:GET /api/wr/events",
      ])
    } finally {
      await runtime.host.dispose()
    }
  })

  test("private-network exposure protects PTY WebSocket upgrades", async () => {
    const seen: string[] = []
    const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement,
      exposure: privateNetworkWorkspaceRuntimeExposure({
        name: "test-private-network",
        guard: (input) => {
          seen.push(`guard:${input.method} ${input.path}`)
          return true
        },
        runtimeAuth: (input) => {
          seen.push(`auth:${input.method} ${input.path}`)
          return false
        },
      }),
    })
    const server = serve({
      fetch: runtime.app.fetch,
      port: 0,
      hostname: "127.0.0.1",
    })
    runtime.injectWebSocket(server)
    try {
      const port = await waitForWorkspaceRuntimeServerPort(server, 0)
      await expectWebSocketOpenFailure(`ws://127.0.0.1:${port}/api/wr/pty/missing/connect`)

      expect(seen).toEqual([
        "guard:GET /api/wr/pty/missing/connect",
        "auth:GET /api/wr/pty/missing/connect",
      ])
    } finally {
      server.close()
      await runtime.host.dispose()
      await Pty.dispose()
    }
  })

  test("can disable runtime CORS when driver proxy owns CORS", async () => {
    const previousNeutral = process.env.WORKSPACE_RUNTIME_DISABLE_CORS
    process.env.WORKSPACE_RUNTIME_DISABLE_CORS = "1"
    const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement, exposure: loopbackWorkspaceRuntimeExposure() })
    try {
      const res = await runtime.app.request("http://localhost/global/health", {
        headers: { Origin: "http://localhost:4444" },
      })
      expect(res.headers.get("access-control-allow-origin")).toBeNull()
    } finally {
      if (previousNeutral === undefined) delete process.env.WORKSPACE_RUNTIME_DISABLE_CORS
      else process.env.WORKSPACE_RUNTIME_DISABLE_CORS = previousNeutral
      await runtime.host.dispose()
    }
  })

  test("CORS origin policy derives from exposure kind", async () => {
    const local = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement, exposure: loopbackWorkspaceRuntimeExposure() })
    const relayed = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement, exposure: relayWorkspaceRuntimeExposure(relayHostAuth) })
    const privateNetwork = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement,
      exposure: privateNetworkWorkspaceRuntimeExposure({
        name: "test-private-network",
        guard: () => true,
        runtimeAuth: () => true,
      }),
    })
    const embedded = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement,
      exposure: embeddedWorkspaceRuntimeExposure({
        owner: "test",
        guard: () => true,
      }),
    })

    try {
      const localAllowed = await local.app.request("http://localhost/api/wr/health", {
        headers: { Origin: "http://localhost:4444" },
      })
      // Kit default is loopback-only with NO product domains — opencode.ai is a
      // host policy string that no longer lives in the kit.
      const localHosted = await local.app.request("http://localhost/api/wr/health", {
        headers: { Origin: "https://app.opencode.ai" },
      })
      const localDenied = await local.app.request("http://localhost/api/wr/health", {
        headers: { Origin: "https://evil.example" },
      })
      const relayDenied = await relayed.app.request("http://localhost/global/health", {
        headers: { Origin: "http://localhost:4444" },
      })
      const privateNetworkDenied = await privateNetwork.app.request("http://localhost/api/wr/health", {
        headers: { Origin: "http://localhost:4444" },
      })
      const embeddedDenied = await embedded.app.request("http://localhost/api/wr/health", {
        headers: { Origin: "http://localhost:4444" },
      })

      expect(localAllowed.headers.get("access-control-allow-origin")).toBe("http://localhost:4444")
      expect(localHosted.headers.get("access-control-allow-origin")).toBeNull()
      expect(localDenied.headers.get("access-control-allow-origin")).toBeNull()
      expect(relayDenied.headers.get("access-control-allow-origin")).toBeNull()
      expect(privateNetworkDenied.headers.get("access-control-allow-origin")).toBeNull()
      expect(embeddedDenied.headers.get("access-control-allow-origin")).toBeNull()
    } finally {
      await local.host.dispose()
      await relayed.host.dispose()
      await privateNetwork.host.dispose()
      await embedded.host.dispose()
    }
  })

  test("health reports the effective auth boundary and service exposure", async () => {
    const local = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement, exposure: loopbackWorkspaceRuntimeExposure() })
    const relayed = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement,
      exposure: relayWorkspaceRuntimeExposure(relayHostAuth),
      relayHostAuth,
      configToken: "cfg-secret",
      serviceExposure: {
        source: "driver-service-url",
        access: "public",
        driver: "vercel",
      },
    })
    try {
      await expect(Promise.resolve(local.app.request("http://localhost/api/wr/health")).then((res: Response) => res.json())).resolves.toMatchObject({
        routeAuthBoundary: "loopback-only",
        serviceExposure: {
          source: "loopback",
          access: "private",
        },
      })
      // The exposure report is diagnostics: it rides the authenticated probe,
      // never the anonymous `/global/health` answer.
      await expect(Promise.resolve(relayed.app.request("http://localhost/api/wr/health", {
        headers: { authorization: "Bearer cfg-secret" },
      })).then((res: Response) => res.json())).resolves.toMatchObject({
        routeAuthBoundary: "relay-host-auth",
        serviceExposure: {
          source: "driver-service-url",
          access: "public",
          driver: "vercel",
        },
      })
      expect(workspaceRuntimeRouteAuthBoundary({ }, "0.0.0.0", { WORKSPACE_RUNTIME_ALLOW_UNAUTHENTICATED_NON_LOOPBACK: "1",
      })).toBe("private-network-dev-unsafe")
      expect(workspaceRuntimeServiceExposureFromEnv({
        WORKSPACE_RUNTIME_SERVICE_EXPOSURE_SOURCE: "driver-service-url",
        WORKSPACE_RUNTIME_SERVICE_EXPOSURE_ACCESS: "public",
        WORKSPACE_RUNTIME_SERVICE_EXPOSURE_DRIVER: "vercel",
      })).toEqual({
        source: "driver-service-url",
        access: "public",
        driver: "vercel",
      })
    } finally {
      await local.host.dispose()
      await relayed.host.dispose()
    }
  })

  test("the anonymous global probe answers liveness and identity, not diagnostics", async () => {
    const dir = await pinTempWorkspaceDirectory()
    const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement,
      exposure: loopbackWorkspaceRuntimeExposure(),
      target: { workspaceId: "health-workspace", directory: dir },
    })
    try {
      const response = await runtime.app.request("http://localhost/global/health")
      expect(response.status).toBe(200)
      const body = await response.json() as Record<string, unknown>
      expect(body).toMatchObject({
        healthy: true,
        ok: true,
        service: "workspace-runtime",
        workspaceId: "health-workspace",
      })
      // Diagnostics — inventory, paths, harness and process state — stay
      // behind the authenticated `/api/wr/health` probe.
      for (const field of [
        "directory", "capabilities", "profile", "harness", "harnessHealth",
        "connectionState", "configApply", "controlPlane", "routeAuthBoundary",
        "serviceExposure", "exposure", "ptyCount",
      ]) {
        expect(body).not.toHaveProperty(field)
      }
    } finally {
      await runtime.host.dispose()
    }
  })

  test("the authenticated health probe reports the terminal counter the supervisor's idle check reads", async () => {
    const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement,
      exposure: relayWorkspaceRuntimeExposure(relayHostAuth),
      relayHostAuth,
      configToken: "cfg-secret",
    })
    try {
      const denied = await runtime.app.request("http://localhost/api/wr/health")
      expect(denied.status).toBe(401)

      const response = await runtime.app.request("http://localhost/api/wr/health", {
        headers: { authorization: "Bearer cfg-secret" },
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ ptyCount: 0 })
    } finally {
      await runtime.host.dispose()
    }
  })

  test("relay-authenticated runtime mounts reject anonymous sensitive host routes", async () => {
    const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement, exposure: relayWorkspaceRuntimeExposure(relayHostAuth) })
    try {
      const response = await runtime.app.request("http://localhost/api/wr/capabilities")

      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({
        error: {
          code: "relay_host_token_required",
          message: "Relay Host Token is required",
        },
      })
    } finally {
      await runtime.host.dispose()
    }
  })

  test("config tokens only authorize health when relay auth is mounted", async () => {
    const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement, exposure: relayWorkspaceRuntimeExposure(relayHostAuth), relayHostAuth, configToken: "cfg-secret" })
    try {
      const health = await runtime.app.request("http://localhost/api/wr/health", {
        headers: { authorization: "Bearer cfg-secret" },
      })
      expect(health.status).toBe(200)

      const config = await runtime.app.request("http://localhost/api/wr/config", {
        method: "POST",
        headers: {
          authorization: "Bearer cfg-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: 4,
          commands: [],
          mcp: {},
          connections: [],
          defaultHarness: { kind: "native", harnessId: "pi" },
          auth: { machineOwnerUserId: "local", accounts: { local: {} } },
        }),
      })
      expect(config.status).toBe(401)

      const session = await runtime.app.request("http://localhost/session", {
        method: "POST",
        headers: {
          authorization: "Bearer cfg-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      })
      expect(session.status).toBe(401)
      expect(await session.json()).toEqual({
        error: {
          code: "invalid_relay_token",
          message: "Relay Host Token is invalid",
        },
      })

      const capabilities = await runtime.app.request("http://localhost/api/wr/capabilities", {
        headers: { authorization: "Bearer cfg-secret" },
      })
      const files = await runtime.app.request("http://localhost/file/readdir?path=.", {
        headers: { authorization: "Bearer cfg-secret" },
      })

      expect(capabilities.status).toBe(401)
      expect(await capabilities.json()).toEqual({
        error: {
          code: "invalid_relay_token",
          message: "Relay Host Token is invalid",
        },
      })
      expect(files.status).toBe(401)
      expect(await files.json()).toEqual({
        error: {
          code: "invalid_relay_token",
          message: "Relay Host Token is invalid",
        },
      })
    } finally {
      await runtime.host.dispose()
    }
  })

  test("terminal hook capabilities authorize only POST lifecycle in their recorded workspace", async () => {
    const access = spyOn(Pty, "agentHookAccessForToken").mockImplementation((token) => token === "hook-ws-1"
      ? {
          terminalId: "pty_hook",
          token: "hook-ws-1",
          context: {
            actor: { actorId: "actor_1", actorKind: "human" },
            authority: { managed: true, workspaceId: "ws_1", orgId: "org_1", role: "editor" },
          },
          sessionId: "session_hook",
          authorityLease: "lease-ws-1",
          authorityExpiresAt: Date.now() + 15_000,
        }
      : token === "hook-ws-other"
        ? {
            terminalId: "pty_hook",
            token: "hook-ws-other",
            context: {
              actor: { actorId: "actor_other", actorKind: "human" },
              authority: { managed: true, workspaceId: "ws_other", orgId: "org_other", role: "editor" },
            },
            sessionId: "session_hook",
            authorityLease: "lease-ws-other",
            authorityExpiresAt: Date.now() + 15_000,
          }
        : undefined)
    const owner = spyOn(Pty, "accessOwner").mockReturnValue("actor_1")
    const renew = spyOn(Pty, "renewAgentHookAccess").mockReturnValue(true)
    const terminal = spyOn(Pty, "get").mockReturnValue({
      id: "pty_hook",
      sessionId: "session_hook",
      title: "hook",
      command: "/bin/sh",
      args: [],
      cwd: "/tmp",
      status: "running",
      pid: 1,
    })
    const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement,
      exposure: relayWorkspaceRuntimeExposure(relayHostAuth),
      relayHostAuth,
      sessionAccessPolicy: {
        sessionAuthority: "managed-private",
        authorizeSessionStartStatus: () => ({ allowed: false as const, status: 403 as const, code: "startup_not_tested", message: "Startup is not admitted by this fixture" }),
        authorizeSessionStart: () => ({ allowed: false as const, status: 403 as const, code: "startup_not_tested", message: "Startup is not admitted by this fixture" }),
        authorize: async () => ({ allowed: true }),
        filterSessions: async (input) => input.sessionIds,
        authorizePrefix: async () => ({ allowed: true }),
        authorizeStream: async (_input, lease) => ({
          allowed: true,
          lease: lease ?? "terminal-lease",
          expiresAt: Date.now() + 15_000,
        }),
      } satisfies SessionAccessPolicy,
    })
    try {
      const lifecycle = await runtime.app.request("http://localhost/api/wr/hook/agent-lifecycle", {
        method: "POST",
        headers: { authorization: "Bearer hook-ws-1", "content-type": "application/json" },
        body: JSON.stringify({ tabId: "tab_hook", terminalId: "pty_hook", eventType: "Busy" }),
      })
      expect(lifecycle.status).toBe(200)

      const wrongWorkspace = await runtime.app.request("http://localhost/api/wr/hook/agent-lifecycle", {
        method: "POST",
        headers: { authorization: "Bearer hook-ws-other", "content-type": "application/json" },
        body: JSON.stringify({ tabId: "tab_hook", terminalId: "pty_hook", eventType: "Busy" }),
      })
      expect(wrongWorkspace.status).toBe(401)

      const wrongMethod = await runtime.app.request(
        "http://localhost/api/wr/hook/agent-lifecycle?tabId=tab_hook&terminalId=pty_hook&eventType=Busy",
        { headers: { authorization: "Bearer hook-ws-1" } },
      )
      expect(wrongMethod.status).toBe(401)

      const wrongRoute = await runtime.app.request("http://localhost/api/wr/health", {
        headers: { authorization: "Bearer hook-ws-1" },
      })
      expect(wrongRoute.status).toBe(401)
    } finally {
      access.mockRestore()
      owner.mockRestore()
      terminal.mockRestore()
      renew.mockRestore()
      await runtime.host.dispose()
    }
  })

  test("management config push is not preempted by relay auth", async () => {
    await pinTempWorkspaceDirectory()
    const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement,
      exposure: relayWorkspaceRuntimeExposure(relayHostAuth),
      relayHostAuth,
      managementAuth,
      managementTarget: {
        workspaceId: "ws_1",
        hostId: "host_1",
      },
    })
    try {
      const config = await runtime.app.request("http://localhost/api/wr/config", {
        method: "POST",
        headers: {
          [WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER]: managementToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: 4,
          commands: [],
          mcp: {},
          connections: [],
          defaultHarness: { kind: "native", harnessId: "pi" },
          auth: { machineOwnerUserId: "local", accounts: { local: {} } },
        }),
      })
      expect(config.status).toBe(200)
      expect(await config.json()).toEqual({ ok: true })
    } finally {
      await runtime.host.dispose()
    }
  })
})

describe("workspace runtime drain", () => {
  test("closes ingress and disposes workspace-owned resources in order", async () => {
    const events: string[] = []

    await drainWorkspaceRuntime({
      server: { close: () => events.push("server.close") },
      hostTunnel: { close: () => events.push("hostTunnel.close") },
      drainTimeoutMs: 1000,
      ptyDispose: async () => {
        events.push("pty.dispose")
      },
      runtime: {
        host: {
          dispose: () => events.push("host.dispose"),
        },
      },
      hostDrain: async () => {
        events.push("host.drain")
      },
    })

    expect(events).toEqual([
      "server.close",
      "hostTunnel.close",
      "pty.dispose",
      "host.dispose",
      "host.drain",
    ])
  })

  test("returns after the drain timeout when subsystem cleanup hangs", async () => {
    const events: string[] = []
    const startedAt = performance.now()

    await drainWorkspaceRuntime({
      server: { close: () => events.push("server.close") },
      drainTimeoutMs: 5,
      ptyDispose: async () => {
        events.push("pty.dispose")
        await new Promise(() => {})
      },
      runtime: {
        host: {
          dispose: () => events.push("host.dispose"),
        },
      },
    })

    expect(performance.now() - startedAt).toBeLessThan(500)
    expect(events).toEqual([
      "server.close",
      "pty.dispose",
    ])
  })

  test("continues later cleanup steps when an earlier drain step fails", async () => {
    const events: string[] = []

    await expect(drainWorkspaceRuntime({
      server: { close: () => events.push("server.close") },
      drainTimeoutMs: 1000,
      ptyDispose: async () => {
        events.push("pty.dispose")
        throw new Error("pty cleanup failed")
      },
      runtime: {
        host: {
          dispose: () => events.push("host.dispose"),
        },
      },
    })).rejects.toThrow("Workspace runtime drain failed")

    expect(events).toEqual([
      "server.close",
      "pty.dispose",
      "host.dispose",
    ])
  })

  test("removes live PTYs through the real drain path", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-drain-pty-"))
    const pty = await withSessionCore(testSessionCore(dir), () => Pty.create({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: dir,
      title: "drain-pty",
    }, ownership))

    try {
      expect(Pty.get(pty.id)?.id).toBe(pty.id)

      await drainWorkspaceRuntime({
        server: { close() {} },
        drainTimeoutMs: 2_000,
        runtime: {
          host: {
            dispose() {},
          },
        },
      })

      expect(Pty.get(pty.id)).toBeUndefined()
    } finally {
      await Pty.dispose()
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("workspace runtime shutdown handler", () => {
  test("drains and exits zero for termination signals", async () => {
    const events: string[] = []
    const shutdown = createWorkspaceRuntimeShutdownHandler({
      drainTimeoutMs: () => 25,
      drain: async (timeout) => {
        events.push(`drain:${timeout}`)
      },
      exit: (code) => {
        events.push(`exit:${code}`)
      },
      log: {
        error: (...args) => events.push(`error:${args[0]}`),
        log: (...args) => events.push(`log:${args[0]}`),
      },
    })

    await shutdown("SIGTERM")

    expect(events).toEqual([
      "log:[workspace-runtime] received SIGTERM, draining (timeout 25ms)",
      "drain:25",
      "exit:0",
    ])
  })

  test("treats unhandled rejections as fatal drain and restart signals", async () => {
    const events: string[] = []
    const reason = new Error("detached task failed")
    const shutdown = createWorkspaceRuntimeShutdownHandler({
      drainTimeoutMs: () => 50,
      drain: async (timeout) => {
        events.push(`drain:${timeout}`)
      },
      exit: (code) => {
        events.push(`exit:${code}`)
      },
      log: {
        error: (...args) => events.push(`error:${args[0]}:${args[1] === reason}`),
        log: (...args) => events.push(`log:${args[0]}`),
      },
    })

    await shutdown("unhandledRejection", reason)

    expect(events).toEqual([
      "error:[workspace-runtime] fatal unhandledRejection; draining for restart (timeout 50ms):true",
      "drain:50",
      "exit:1",
    ])
  })

  test("keeps shutdown idempotent but preserves a later fatal exit code", async () => {
    const events: string[] = []
    let releaseDrain: (() => void) | undefined
    const shutdown = createWorkspaceRuntimeShutdownHandler({
      drainTimeoutMs: () => 75,
      drain: async (timeout) => {
        events.push(`drain:${timeout}`)
        await new Promise<void>((resolve) => {
          releaseDrain = resolve
        })
      },
      exit: (code) => {
        events.push(`exit:${code}`)
      },
      log: {
        error: (...args) => events.push(`error:${args[0]}`),
        log: (...args) => events.push(`log:${args[0]}`),
      },
    })

    const first = shutdown("SIGTERM")
    await Promise.resolve()
    const second = shutdown("uncaughtException", new Error("panic"))
    releaseDrain?.()
    await first
    await second

    expect(events).toEqual([
      "log:[workspace-runtime] received SIGTERM, draining (timeout 75ms)",
      "drain:75",
      "exit:1",
    ])
  })
})

describe("createWorkspaceRuntimeApp assembly (characterization)", () => {
  test("requires an exposure", () => {
    expect(() => createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement })).toThrow("Workspace runtime exposure is required")
  })

  test("the health snapshot carries the lease epoch it was booted with", async () => {
    const previous = process.env.WORKSPACE_RUNTIME_EPOCH
    const health = async () => {
      const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement, exposure: loopbackWorkspaceRuntimeExposure() })
      try {
        return await (await runtime.app.request("http://localhost/global/health")).json()
      } finally {
        await runtime.host.dispose()
      }
    }
    try {
      process.env.WORKSPACE_RUNTIME_EPOCH = "7"
      expect(await health()).toMatchObject({ epoch: 7 })

      // No lease, nothing to fence: a control plane must not read one.
      delete process.env.WORKSPACE_RUNTIME_EPOCH
      expect(await health()).not.toHaveProperty("epoch")

      process.env.WORKSPACE_RUNTIME_EPOCH = "not-a-generation"
      expect(await health()).not.toHaveProperty("epoch")
    } finally {
      if (previous === undefined) delete process.env.WORKSPACE_RUNTIME_EPOCH
      else process.env.WORKSPACE_RUNTIME_EPOCH = previous
    }
  })

  test("mounts /api/wr/health, /api/wr/capabilities, and /global/health", async () => {
    const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement, exposure: loopbackWorkspaceRuntimeExposure() })
    try {
      const health = await runtime.app.request("http://localhost/api/wr/health")
      expect(health.status).toBe(200)
      expect(await health.json()).toMatchObject({
        service: "workspace-runtime",
        status: "ready",
      })

      const capabilities = await runtime.app.request("http://localhost/api/wr/capabilities")
      expect(capabilities.status).toBe(200)
      expect(await capabilities.json()).toHaveProperty("profile")

      const globalHealth = await runtime.app.request("http://localhost/global/health")
      expect(globalHealth.status).toBe(200)
      expect(await globalHealth.json()).toMatchObject({
        service: "workspace-runtime",
        healthy: true,
      })
    } finally {
      await runtime.host.dispose()
    }
  })

  test("health observes configured ACP without launching or resolving credentials and guards session reads", async () => {
    const dir = await pinTempWorkspaceDirectory()
    let secretsRead = 0
    let harnessAcquisitions = 0
    let allowed = false
    const operations: string[] = []
    const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement,
      exposure: loopbackWorkspaceRuntimeExposure(),
      target: { workspaceId: "health-workspace", directory: dir },
      storeRoot: path.join(dir, "state"),
      beforeHarnessAcquire: async () => { harnessAcquisitions++ },
      resolveConnectionSecrets: () => { secretsRead++; return { secrets: { token: "private-token" }, secretLeaseGeneration: "private-lease" } },
      sessionAccessPolicy: { ...managedWorkspaceSessionAccessPolicy(), authorize(input) {
        operations.push(`${input.operation}:${input.sessionId}`)
        return allowed ? { allowed: true } : { allowed: false, status: 403, code: "forbidden", message: "Forbidden" }
      } },
    })
    try {
      await runtime.host.apply({ version: 4, commands: [], mcp: {}, auth: { machineOwnerUserId: "local", accounts: { local: {} } }, connections: [{ connectionId: "health-acp", providerKey: "acp", configRevision: 1, enabled: true, secretRefs: { token: "vault/token" }, config: { label: "ACP", secretBindings: { env: { TOKEN: "token" } }, connection: { kind: "process", command: "/does-not-exist-health-must-not-launch" } } }], defaultHarness: { kind: "connection", connectionId: "health-acp" } })
      const initialReads = secretsRead
      const response = await runtime.app.request("http://localhost/api/wr/health")
      const body = await response.json()
      expect(body.connectionState).toEqual({ connectionId: "health-acp", state: "configured", processes: [] })
      expect(JSON.stringify(body)).not.toContain("private-")
      expect(operations).toEqual([])
      expect((await runtime.app.request("http://localhost/api/wr/health?sessionId=unknown")).status).toBe(403)
      allowed = true
      expect((await runtime.app.request("http://localhost/api/wr/health?sessionId=unknown")).status).toBe(200)
      expect(operations).toEqual(["session_meta_read:unknown", "session_meta_read:unknown"])
      expect(secretsRead).toBe(initialReads)
      expect(harnessAcquisitions).toBe(0)
    } finally { await runtime.host.dispose() }
  })

  test("creates a native session before its initial config exists", async () => {
    // The session store is durable under `storeRoot`; the kit default is the
    // machine-wide runtime store, where a fixed session id from an earlier run
    // would already be bound to another throwaway directory.
    const peer = await installFakePiRpc()
    const originalPi = process.env.PI_EXECUTABLE
    process.env.PI_EXECUTABLE = peer.binary
    const dir = await pinTempWorkspaceDirectory()
    const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement,
      exposure: loopbackWorkspaceRuntimeExposure(),
      harness: { kind: "native", harnessId: "pi" },
      storeRoot: path.join(dir, "state"),
    })
    try {
      const created = await runtime.app.request("http://localhost/session?nativeHarness=pi", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "session-pi-create", title: "Pi create" }),
      })
      expect(created.status).toBe(201)
      const config = await runtime.app.request("http://localhost/session/session-pi-create/config")
      expect(config.status).toBe(200)
      expect(await config.json()).toMatchObject({ harness: { id: "pi", access: "native" } })
    } finally {
      await runtime.host.dispose()
      if (originalPi === undefined) delete process.env.PI_EXECUTABLE
      else process.env.PI_EXECUTABLE = originalPi
      await peer.dispose()
    }
  })

  test("does not expose the removed session-env bridge", async () => {
    const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement, exposure: loopbackWorkspaceRuntimeExposure() })
    try {
      const paths = runtime.app.routes.map((route) => route.path)
      expect(paths).toContain("/api/wr/capabilities")
      expect(paths.filter((route) => route.includes("session-env"))).toEqual([])
    } finally {
      await runtime.host.dispose()
    }
  })

  test("session-env inherits relay-host auth under relay exposure", async () => {
    const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement, exposure: relayWorkspaceRuntimeExposure(relayHostAuth) })
    try {
      const exists = await runtime.app.request("http://localhost/api/wr/session-env/file/exists?path=x.txt")
      expect(exists.status).toBe(401)
      expect(await exists.json()).toEqual({
        error: {
          code: "relay_host_token_required",
          message: "Relay Host Token is required",
        },
      })
    } finally {
      await runtime.host.dispose()
    }
  })
})

describe("relay-host auth middleware (characterization)", () => {
  test("rejects unauthenticated requests under relay exposure", async () => {
    const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement, exposure: relayWorkspaceRuntimeExposure(relayHostAuth) })
    try {
      const capabilities = await runtime.app.request("http://localhost/api/wr/capabilities")
      expect(capabilities.status).toBe(401)
      expect(await capabilities.json()).toEqual({
        error: {
          code: "relay_host_token_required",
          message: "Relay Host Token is required",
        },
      })
    } finally {
      await runtime.host.dispose()
    }
  })

  test("management token reads and applies settings through the relay auth boundary", async () => {
    await pinTempWorkspaceDirectory()
    const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement,
      exposure: relayWorkspaceRuntimeExposure(relayHostAuth),
      relayHostAuth,
      managementAuth,
      managementTarget: { workspaceId: "ws_1", hostId: "host_1" },
    })
    try {
      const client = createWorkspaceRuntimeClient({ baseUrl: "http://localhost", fetch: (url, init) => Promise.resolve(runtime.app.fetch(new Request(url, init))) })
      const idle = await client.configStatus({ token: managementToken })
      expect(idle).toEqual(runtime.host.detail().configApply)
      expect(idle.state).toBe("idle")
      await expect(client.configStatus({ token: "wrong-token" })).rejects.toMatchObject({ status: 401 })
      const config = await runtime.app.request("http://localhost/api/wr/config", {
        method: "POST",
        headers: {
          [WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER]: managementToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: 4,
          commands: [],
          mcp: {},
          connections: [],
          defaultHarness: { kind: "native", harnessId: "pi" },
          auth: { machineOwnerUserId: "local", accounts: { local: {} } },
        }),
      })
      expect(config.status).toBe(200)
      expect(await config.json()).toEqual({ ok: true })
      const applied = await client.configStatus({ token: managementToken })
      expect(applied).toEqual(runtime.host.detail().configApply)
      expect(applied.state).toBe("applied")

      // The bypass only applies to the config route with a management-token
      // header present; other routes still require relay auth.
      const capabilities = await runtime.app.request("http://localhost/api/wr/capabilities", {
        headers: { [WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER]: managementToken },
      })
      expect(capabilities.status).toBe(401)
    } finally {
      await runtime.host.dispose()
    }
  })

  test("config push without a management-token header is preempted by relay auth", async () => {
    const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement,
      exposure: relayWorkspaceRuntimeExposure(relayHostAuth),
      relayHostAuth,
      managementAuth,
      managementTarget: { workspaceId: "ws_1", hostId: "host_1" },
    })
    try {
      const config = await runtime.app.request("http://localhost/api/wr/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          mcp: {},
          runner: { type: "opencode" },
          auth: { machineOwnerUserId: "local", accounts: { local: {} } },
        }),
      })
      // The bypass requires a non-empty management-token header; without it the
      // relay auth middleware runs first and rejects.
      expect(config.status).toBe(401)
      expect(await config.json()).toEqual({
        error: {
          code: "relay_host_token_required",
          message: "Relay Host Token is required",
        },
      })
    } finally {
      await runtime.host.dispose()
    }
  })
})

describe("startServer ephemeral bind (characterization)", () => {
  test("binds an ephemeral port and serves health, then closes cleanly", async () => {
    const signals = ["SIGTERM", "SIGINT", "unhandledRejection", "uncaughtException"] as const
    // startServer registers process-level shutdown handlers (whose real path
    // calls process.exit). Snapshot the listeners so we can detach the ones it
    // adds without exiting the test runner.
    const listenersOf = (sig: (typeof signals)[number]) => process.listeners(sig as NodeJS.Signals).slice()
    const before = new Map(signals.map((sig) => [sig, listenersOf(sig)]))

    const server = startServer(0, { sessionIdWorkspace: () => undefined, placement, exposure: loopbackWorkspaceRuntimeExposure() })
    try {
      const port = await waitForWorkspaceRuntimeServerPort(server, 0)
      expect(port).toBeGreaterThan(0)

      const health = await fetch(`http://127.0.0.1:${port}/api/wr/health`)
      expect(health.status).toBe(200)
      expect(await health.json()).toMatchObject({ service: "workspace-runtime" })
    } finally {
      // Detach only the handlers startServer added (avoids invoking the real
      // process.exit drain path and prevents cross-test listener leakage).
      for (const sig of signals) {
        const previous = before.get(sig) ?? []
        for (const listener of listenersOf(sig)) {
          if (!previous.includes(listener)) process.removeListener(sig, listener as never)
        }
      }
      server.close()
      await Pty.dispose()
    }
  })
})

describe("cors + signal registration (characterization)", () => {
  test("kit default loopback exposure allows localhost + 127.0.0.1 but NOT opencode.ai", () => {
    const exposure = loopbackWorkspaceRuntimeExposure()
    expect(workspaceRuntimeCorsOrigin(exposure, "http://localhost:4444")).toBe("http://localhost:4444")
    expect(workspaceRuntimeCorsOrigin(exposure, "http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000")
    // opencode.ai is a product string — no longer in the kit default. A host
    // that wants it supplies its own corsOrigin policy.
    expect(workspaceRuntimeCorsOrigin(exposure, "https://app.opencode.ai")).toBeUndefined()
    expect(workspaceRuntimeCorsOrigin(exposure, "https://evil.example")).toBeUndefined()
  })

  test("non-loopback exposure allows no cors origins", () => {
    const exposure = relayWorkspaceRuntimeExposure(relayHostAuth)
    expect(workspaceRuntimeCorsOrigin(exposure, "http://localhost:4444")).toBeUndefined()
    expect(workspaceRuntimeCorsOrigin(exposure, "https://app.opencode.ai")).toBeUndefined()
  })

  test("a host-supplied corsOrigin policy is used instead of the kit default", async () => {
    const seen: Array<{ origin: string; kind: string }> = []
    const runtime = createWorkspaceRuntimeApp({ sessionIdWorkspace: () => undefined,
    placement,
      exposure: loopbackWorkspaceRuntimeExposure(),
      corsOrigin: (origin, exposure) => {
        seen.push({ origin, kind: exposure.kind })
        return origin === "https://app.opencode.ai" ? origin : undefined
      },
    })
    try {
      const hosted = await runtime.app.request("http://localhost/api/wr/health", {
        headers: { Origin: "https://app.opencode.ai" },
      })
      // The kit default would deny opencode.ai; the host policy allows it.
      expect(hosted.headers.get("access-control-allow-origin")).toBe("https://app.opencode.ai")

      const localDenied = await runtime.app.request("http://localhost/api/wr/health", {
        headers: { Origin: "http://localhost:4444" },
      })
      // The host policy is authoritative — it does not allow localhost here,
      // proving the kit default was replaced, not merged.
      expect(localDenied.headers.get("access-control-allow-origin")).toBeNull()
      expect(seen).toContainEqual({ origin: "https://app.opencode.ai", kind: "loopback" })
    } finally {
      await runtime.host.dispose()
    }
  })

  test("startServer with default lifecycle registers zero process handlers", async () => {
    const before = {
      sigterm: process.listenerCount("SIGTERM"),
      sigint: process.listenerCount("SIGINT"),
      rejection: process.listenerCount("unhandledRejection"),
      exception: process.listenerCount("uncaughtException"),
    }
    const preTerm = process.listeners("SIGTERM")
    const preInt = process.listeners("SIGINT")
    const preRej = process.listeners("unhandledRejection")
    const preExc = process.listeners("uncaughtException")
    // Default: no lifecycle argument → the library must not claim the process.
    const server = startServer(0, { sessionIdWorkspace: () => undefined, placement,
      target: { workspaceId: "ws-signals-default", directory: path.join(os.tmpdir(), "server-signals-root") },
      exposure: loopbackWorkspaceRuntimeExposure(),
    })
    try {
      expect(process.listenerCount("SIGTERM")).toBe(before.sigterm)
      expect(process.listenerCount("SIGINT")).toBe(before.sigint)
      expect(process.listenerCount("unhandledRejection")).toBe(before.rejection)
      expect(process.listenerCount("uncaughtException")).toBe(before.exception)
    } finally {
      server.close()
      for (const item of process.listeners("SIGTERM")) if (!preTerm.includes(item)) process.removeListener("SIGTERM", item)
      for (const item of process.listeners("SIGINT")) if (!preInt.includes(item)) process.removeListener("SIGINT", item)
      for (const item of process.listeners("unhandledRejection")) if (!preRej.includes(item)) process.removeListener("unhandledRejection", item)
      for (const item of process.listeners("uncaughtException")) if (!preExc.includes(item)) process.removeListener("uncaughtException", item)
      await Pty.dispose()
    }
  })

  test("startServer with { signals: true } registers the four process handlers", async () => {
    const before = {
      sigterm: process.listenerCount("SIGTERM"),
      sigint: process.listenerCount("SIGINT"),
      rejection: process.listenerCount("unhandledRejection"),
      exception: process.listenerCount("uncaughtException"),
    }
    const preTerm = process.listeners("SIGTERM")
    const preInt = process.listeners("SIGINT")
    const preRej = process.listeners("unhandledRejection")
    const preExc = process.listeners("uncaughtException")
    const server = startServer(0, { sessionIdWorkspace: () => undefined, placement,
      target: { workspaceId: "ws-signals", directory: path.join(os.tmpdir(), "server-signals-root") },
      exposure: loopbackWorkspaceRuntimeExposure(),
    }, { signals: true })
    try {
      expect(process.listenerCount("SIGTERM")).toBe(before.sigterm + 1)
      expect(process.listenerCount("SIGINT")).toBe(before.sigint + 1)
      expect(process.listenerCount("unhandledRejection")).toBe(before.rejection + 1)
      expect(process.listenerCount("uncaughtException")).toBe(before.exception + 1)
    } finally {
      server.close()
      for (const item of process.listeners("SIGTERM")) if (!preTerm.includes(item)) process.removeListener("SIGTERM", item)
      for (const item of process.listeners("SIGINT")) if (!preInt.includes(item)) process.removeListener("SIGINT", item)
      for (const item of process.listeners("unhandledRejection")) if (!preRej.includes(item)) process.removeListener("unhandledRejection", item)
      for (const item of process.listeners("uncaughtException")) if (!preExc.includes(item)) process.removeListener("uncaughtException", item)
      await Pty.dispose()
    }
  })
})

describe("workspace runtime env helpers (characterization)", () => {
  test("runtimeEnvText trims and treats blank values as unset", () => {
    expect(runtimeEnvText({ WORKSPACE_RUNTIME_HOST: " 0.0.0.0 " }, "WORKSPACE_RUNTIME_HOST")).toBe("0.0.0.0")
    expect(runtimeEnvText({ WORKSPACE_RUNTIME_HOST: "   " }, "WORKSPACE_RUNTIME_HOST")).toBeUndefined()
    expect(runtimeEnvText({}, "WORKSPACE_RUNTIME_HOST")).toBeUndefined()
    expect(
      runtimeEnvText({ OPENCODE_PTY_HISTORY_DIR: "/legacy" }, "WORKSPACE_RUNTIME_PTY_HISTORY_DIR"),
    ).toBeUndefined()
  })

  test("workspaceRuntimeDataDir honors WORKSPACE_RUNTIME_DATA_DIR", () => {
    expect(workspaceRuntimeDataDir({ WORKSPACE_RUNTIME_DATA_DIR: "/data/wr" })).toBe("/data/wr")
    expect(workspaceRuntimeDataDir({ WORKSPACE_RUNTIME_DATA_DIR: "  " })).toContain(".workspace-runtime")
  })

  test("configTokenFromEnv reads only WORKSPACE_RUNTIME_CONFIG_TOKEN", () => {
    expect(configTokenFromEnv({
      WORKSPACE_RUNTIME_CONFIG_TOKEN: "cfg",
      WORKSPACE_RUNTIME_TRUSTED_DIRECT_TOKEN: "direct",
    })).toBe("cfg")
    expect(configTokenFromEnv({ WORKSPACE_RUNTIME_TRUSTED_DIRECT_TOKEN: "direct" })).toBeUndefined()
    expect(configTokenFromEnv({})).toBeUndefined()
  })

  test("managementTargetFromEnv resolves workspace and host ids", () => {
    expect(managementTargetFromEnv({
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_env",
      WORKSPACE_RUNTIME_HOST_ID: "host_env",
    })).toEqual({ workspaceId: "ws_env", hostId: "host_env" })
    // host id defaults to the workspace id when unset.
    expect(managementTargetFromEnv({ WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_only" })).toEqual({
      workspaceId: "ws_only",
      hostId: "ws_only",
    })
  })

  test("hostTunnelFromEnv is undefined without a relay URL and parses target ids/port when set", () => {
    expect(hostTunnelFromEnv({}, 3002)).toBeUndefined()
    expect(hostTunnelFromEnv({
      WORKSPACE_RUNTIME_RELAY_URL: "https://relay.test/",
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_tunnel",
      WORKSPACE_RUNTIME_HOST_ID: "host_tunnel",
    }, 4321)).toMatchObject({
      relayUrl: "https://relay.test",
      hostId: "host_tunnel",
      workspaceIds: ["ws_tunnel"],
      localBaseUrl: "http://127.0.0.1:4321",
    })
  })
})
