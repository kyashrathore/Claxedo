import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { serve } from "@hono/node-server"
import type { RelayHostAuthOptions } from "./workspace-host-service-auth"
import { WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER, type WorkspaceRuntimeManagementAuth } from "./management-auth"
import { AcpHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
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
} from "./server"
import { Pty } from "./pty/index"
import {
  embeddedWorkspaceRuntimeExposure,
  loopbackWorkspaceRuntimeExposure,
  privateNetworkWorkspaceRuntimeExposure,
  relayWorkspaceRuntimeExposure,
} from "./exposure"
import { runtimeEnvText, workspaceRuntimeDataDir } from "./env"
import {
  configTokenFromEnv,
  hostTunnelFromEnv,
  managementTargetFromEnv,
} from "./workspace-relay-env"

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
    expect(() => assertWorkspaceRuntimeListenPolicy({}, "127.0.0.1", {})).not.toThrow()
    expect(() => assertWorkspaceRuntimeListenPolicy({ configToken: "cfg-secret" }, "localhost", {})).not.toThrow()
  })

  test("rejects unauthenticated non-loopback listeners", () => {
    expect(() => assertWorkspaceRuntimeListenPolicy({}, "0.0.0.0", {})).toThrow(
      "Refusing to listen on non-loopback host 0.0.0.0 without relay-host auth",
    )
  })

  test("does not treat config tokens as whole-server auth", () => {
    expect(() => assertWorkspaceRuntimeListenPolicy({ configToken: "cfg-secret" }, "0.0.0.0", {})).toThrow(
      "Refusing to listen on non-loopback host 0.0.0.0 without relay-host auth",
    )
  })

  test("allows relay-authenticated non-loopback listeners", () => {
    expect(() => assertWorkspaceRuntimeListenPolicy({ relayHostAuth }, "0.0.0.0", {})).not.toThrow()
  })

  test("allows guarded private-network non-loopback listeners", () => {
    const exposure = privateNetworkWorkspaceRuntimeExposure({
      name: "test-private-network",
      guard: () => true,
      runtimeAuth: () => true,
    })
    expect(() =>
      assertWorkspaceRuntimeListenPolicy({
        exposure,
      }, "0.0.0.0", {})
    ).not.toThrow()
    expect(workspaceRuntimeRouteAuthBoundary({ exposure }, "0.0.0.0", {})).toBe("private-network-host-guard")
  })

  test("allows explicitly exempted private-network listeners", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(() => assertWorkspaceRuntimeListenPolicy({}, "0.0.0.0", {
        WORKSPACE_RUNTIME_ALLOW_UNAUTHENTICATED_NON_LOOPBACK: "1",
      })).not.toThrow()
      expect(warn).toHaveBeenCalledWith(
        "[workspace-runtime] WARN  allowing unauthenticated non-loopback listen because WORKSPACE_RUNTIME_ALLOW_UNAUTHENTICATED_NON_LOOPBACK=1",
      )
    } finally {
      warn.mockRestore()
    }
  })
})

describe("workspace runtime host route auth", () => {
  test("private-network exposure runs host guard before runtime auth", async () => {
    const seen: string[] = []
    const runtime = createWorkspaceRuntimeApp({
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
    const runtime = createWorkspaceRuntimeApp({
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
    const runtime = createWorkspaceRuntimeApp({
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
      for (const route of ["/api/wr/runtime-events", "/api/wr/events"]) {
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
        "guard:GET /api/wr/runtime-events",
        "auth:GET /api/wr/runtime-events",
        "guard:GET /api/wr/events",
        "auth:GET /api/wr/events",
      ])
    } finally {
      await runtime.host.dispose()
    }
  })

  test("private-network exposure protects PTY WebSocket upgrades", async () => {
    const seen: string[] = []
    const runtime = createWorkspaceRuntimeApp({
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
    const runtime = createWorkspaceRuntimeApp({ exposure: loopbackWorkspaceRuntimeExposure() })
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
    const local = createWorkspaceRuntimeApp({ exposure: loopbackWorkspaceRuntimeExposure() })
    const relayed = createWorkspaceRuntimeApp({ exposure: relayWorkspaceRuntimeExposure(relayHostAuth) })
    const privateNetwork = createWorkspaceRuntimeApp({
      exposure: privateNetworkWorkspaceRuntimeExposure({
        name: "test-private-network",
        guard: () => true,
        runtimeAuth: () => true,
      }),
    })
    const embedded = createWorkspaceRuntimeApp({
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

  test("global diagnostics report runner degradation without changing public health liveness", async () => {
    const originalListSessions = AcpHarnessAdapter.prototype.listSessions
    const originalReadRuntimeHealth = AcpHarnessAdapter.prototype.readRuntimeHealth
    AcpHarnessAdapter.prototype.listSessions = async () => []
    AcpHarnessAdapter.prototype.readRuntimeHealth = () => ({
      status: "degraded",
      reason: "harness_process_lost",
      message: "ACP session process restarted",
      sessions: [{ id: "s1", status: "recovering", message: "ACP session process restarted" }],
    })
    const runtime = createWorkspaceRuntimeApp({ exposure: loopbackWorkspaceRuntimeExposure(), harness: { id: "claude", access: "acp" } })
    try {
      const status = await runtime.app.request("http://localhost/session/status")
      expect(status.status).toBe(200)

      const diagnostics = await runtime.app.request("http://localhost/global/health").then((res) => res.json())
      expect(diagnostics).toMatchObject({
        ok: false,
        status: "ready",
        healthStatus: "degraded",
        harnessHealth: {
          status: "degraded",
          reason: "harness_process_lost",
          sessions: [{ id: "s1", status: "recovering" }],
        },
      })
      const health = await runtime.app.request("http://localhost/api/wr/health").then((res) => res.json() as Promise<Record<string, unknown>>)
      // Liveness semantics are unchanged by degradation: a degraded harness on a
      // live runtime still reports ok:true/status:"ready". Only the harness-health
      // detail (forwarded for the composer health peek) reflects the degradation.
      expect(health).toMatchObject({
        ok: true,
        status: "ready",
        service: "workspace-runtime",
        agentType: "claude",
        harnessHealth: {
          status: "degraded",
          reason: "harness_process_lost",
          sessions: [{ id: "s1", status: "recovering" }],
        },
      })
      expect(health).toHaveProperty("acpBinary")
      expect(health).toHaveProperty("error")
      // The heavy diagnostics fields stay on /global/health only.
      expect(health).not.toHaveProperty("healthStatus")
      expect(health).not.toHaveProperty("capabilities")
      expect(health).not.toHaveProperty("directory")
      expect(health).not.toHaveProperty("workspaceId")
      expect(health).not.toHaveProperty("ptyCount")
      expect(health).not.toHaveProperty("processCount")
    } finally {
      AcpHarnessAdapter.prototype.listSessions = originalListSessions
      AcpHarnessAdapter.prototype.readRuntimeHealth = originalReadRuntimeHealth
      await runtime.host.dispose()
    }
  })

  test("health reports the effective auth boundary and service exposure", async () => {
    const local = createWorkspaceRuntimeApp({ exposure: loopbackWorkspaceRuntimeExposure() })
    const relayed = createWorkspaceRuntimeApp({
      exposure: relayWorkspaceRuntimeExposure(relayHostAuth),
      relayHostAuth,
      serviceExposure: {
        source: "driver-service-url",
        access: "driver-authenticated",
        driver: "daytona",
        fallbackAccess: "public",
      },
    })
    try {
      await expect(local.app.request("http://localhost/api/wr/health").then((res) => res.json())).resolves.toMatchObject({
        routeAuthBoundary: "loopback-only",
        serviceExposure: {
          source: "loopback",
          access: "private",
        },
      })
      await expect(relayed.app.request("http://localhost/global/health").then((res) => res.json())).resolves.toMatchObject({
        routeAuthBoundary: "relay-host-auth",
        serviceExposure: {
          source: "driver-service-url",
          access: "driver-authenticated",
          driver: "daytona",
          fallbackAccess: "public",
        },
      })
      expect(workspaceRuntimeRouteAuthBoundary({}, "0.0.0.0", {
        WORKSPACE_RUNTIME_ALLOW_UNAUTHENTICATED_NON_LOOPBACK: "1",
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

  test("global diagnostics report control-plane sync as disabled", async () => {
    const runtime = createWorkspaceRuntimeApp({ exposure: loopbackWorkspaceRuntimeExposure() })
    try {
      await expect(runtime.app.request("http://localhost/global/health").then((res) => res.json())).resolves.toMatchObject({
        controlPlane: {
          enabled: false,
          state: "disabled",
          consecutiveFailures: 0,
        },
      })
    } finally {
      await runtime.host.dispose()
    }
  })

  test("relay-authenticated runtime mounts reject anonymous sensitive host routes", async () => {
    const runtime = createWorkspaceRuntimeApp({ exposure: relayWorkspaceRuntimeExposure(relayHostAuth) })
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
    const runtime = createWorkspaceRuntimeApp({ exposure: relayWorkspaceRuntimeExposure(relayHostAuth), relayHostAuth, configToken: "cfg-secret" })
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
          version: 1,
          mcp: {},
          runner: { type: "opencode" },
          auth: {},
        }),
      })
      expect(config.status).toBe(401)

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

  test("management config push is not preempted by relay auth", async () => {
    await pinTempWorkspaceDirectory()
    const runtime = createWorkspaceRuntimeApp({
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
          version: 1,
          mcp: {},
          runner: { type: "opencode" },
          auth: {},
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
      directory: "/tmp/ws",
      drainTimeoutMs: 1000,
      processDispose: async (directory) => {
        events.push(`process.dispose:${directory}`)
      },
      ptyDispose: async () => {
        events.push("pty.dispose")
      },
      runtime: {
        host: {
          dispose: () => events.push("host.dispose"),
        },
      },
    })

    expect(events).toEqual([
      "server.close",
      "hostTunnel.close",
      "process.dispose:/tmp/ws",
      "pty.dispose",
      "host.dispose",
    ])
  })

  test("returns after the drain timeout when subsystem cleanup hangs", async () => {
    const events: string[] = []
    const startedAt = performance.now()

    await drainWorkspaceRuntime({
      server: { close: () => events.push("server.close") },
      directory: "/tmp/ws",
      drainTimeoutMs: 5,
      processDispose: async () => {
        events.push("process.dispose")
        await new Promise(() => {})
      },
      ptyDispose: async () => {
        events.push("pty.dispose")
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
      "process.dispose",
    ])
  })

  test("continues later cleanup steps when an earlier drain step fails", async () => {
    const events: string[] = []

    await expect(drainWorkspaceRuntime({
      server: { close: () => events.push("server.close") },
      directory: "/tmp/ws",
      drainTimeoutMs: 1000,
      processDispose: async () => {
        events.push("process.dispose")
        throw new Error("process cleanup failed")
      },
      ptyDispose: async () => {
        events.push("pty.dispose")
      },
      runtime: {
        host: {
          dispose: () => events.push("host.dispose"),
        },
      },
    })).rejects.toThrow("Workspace runtime drain failed")

    expect(events).toEqual([
      "server.close",
      "process.dispose",
      "pty.dispose",
      "host.dispose",
    ])
  })

  test("removes live PTYs through the real drain path", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wr-drain-pty-"))
    const pty = await Pty.create({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: dir,
      title: "drain-pty",
    })

    try {
      expect(Pty.get(pty.id)?.id).toBe(pty.id)

      await drainWorkspaceRuntime({
        server: { close() {} },
        directory: dir,
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

// ── Characterization: app assembly, relay auth, ephemeral startServer,
//    env helpers (Unit 1). These pin the runnable-host behavior a later unit
//    will move/extract. ────────────────────────────────────────────────────────
describe("createWorkspaceRuntimeApp assembly (characterization)", () => {
  test("requires an exposure", () => {
    expect(() => createWorkspaceRuntimeApp()).toThrow("Workspace runtime exposure is required")
    expect(() => createWorkspaceRuntimeApp({})).toThrow("Workspace runtime exposure is required")
  })

  test("mounts /api/wr/health, /api/wr/capabilities, and /global/health", async () => {
    const runtime = createWorkspaceRuntimeApp({ exposure: loopbackWorkspaceRuntimeExposure() })
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

  test("mounts /api/wr/session-env behind the app middleware", async () => {
    const runtime = createWorkspaceRuntimeApp({ exposure: loopbackWorkspaceRuntimeExposure() })
    try {
      const exists = await runtime.app.request("http://localhost/api/wr/session-env/file/exists?path=definitely-missing.txt")
      expect(exists.status).toBe(200)
      expect(await exists.json()).toEqual({ exists: false })
    } finally {
      await runtime.host.dispose()
    }
  })

  test("session-env inherits relay-host auth under relay exposure", async () => {
    const runtime = createWorkspaceRuntimeApp({ exposure: relayWorkspaceRuntimeExposure(relayHostAuth) })
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
    const runtime = createWorkspaceRuntimeApp({ exposure: relayWorkspaceRuntimeExposure(relayHostAuth) })
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

  test("management token bypasses relay auth for POST /api/wr/config", async () => {
    await pinTempWorkspaceDirectory()
    const runtime = createWorkspaceRuntimeApp({
      exposure: relayWorkspaceRuntimeExposure(relayHostAuth),
      relayHostAuth,
      managementAuth,
      managementTarget: { workspaceId: "ws_1", hostId: "host_1" },
    })
    try {
      // No relay token, but a valid management token — the config-push bypass
      // in the relay middleware lets it through to the management-auth check.
      const config = await runtime.app.request("http://localhost/api/wr/config", {
        method: "POST",
        headers: {
          [WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER]: managementToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: 1,
          mcp: {},
          runner: { type: "opencode" },
          auth: {},
        }),
      })
      expect(config.status).toBe(200)
      expect(await config.json()).toEqual({ ok: true })

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
    const runtime = createWorkspaceRuntimeApp({
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
          auth: {},
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
    const before = new Map(signals.map((sig) => [sig, process.listeners(sig).slice()]))

    const server = startServer(0, { exposure: loopbackWorkspaceRuntimeExposure() })
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
        for (const listener of process.listeners(sig)) {
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
    const runtime = createWorkspaceRuntimeApp({
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
    const server = startServer(0, {
      target: { workspaceId: "ws-signals-default", directory: process.cwd() },
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
    const server = startServer(0, {
      target: { workspaceId: "ws-signals", directory: process.cwd() },
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

  test("configTokenFromEnv prefers the config token over the trusted-direct token", () => {
    expect(configTokenFromEnv({
      WORKSPACE_RUNTIME_CONFIG_TOKEN: "cfg",
      WORKSPACE_RUNTIME_TRUSTED_DIRECT_TOKEN: "direct",
    })).toBe("cfg")
    expect(configTokenFromEnv({ WORKSPACE_RUNTIME_TRUSTED_DIRECT_TOKEN: "direct" })).toBe("direct")
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
