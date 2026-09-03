import { describe, expect, test } from "vitest"
import { Hono } from "hono"
import {
  DEPLOYMENT_MODE_ENV,
  DeploymentModeError,
  UNSIGNED_NONLOOPBACK_ALLOWLIST,
  deploymentMode,
  unsignedLocalRequestGuard,
} from "@claxedo/server-core/authority/deployment-mode"
import type { ControlPlaneAuthConfig } from "@claxedo/server-core/platform/auth/auth"

/**
 * Deployment mode and the global unsigned-local gate.
 * These tests cover mode parsing and the guard's request-time policy. In-process Requests carry no transport peer,
 * so `isLoopbackLocalRequest` falls back to the Host/Origin classification:
 * `http://127.0.0.1/...` = loopback, `http://cp.example.test/...` = remote —
 * the same fallback every other in-process test in this package relies on.
 */

const unsignedLocalConfig: ControlPlaneAuthConfig = {
  enabled: false,
  mode: "local-only",
  reason: "signed/cloud auth is disabled",
}

const misconfiguredConfig: ControlPlaneAuthConfig = {
  enabled: false,
  mode: "misconfigured",
  reason: "signed auth is misconfigured",
}

const enabledConfig: ControlPlaneAuthConfig = {
  enabled: true,
  issuer: "https://idp.example.test",
  jwksUrl: "https://idp.example.test/.well-known/jwks.json",
}

function guardedApp(options: Parameters<typeof unsignedLocalRequestGuard>[0]) {
  const app = new Hono()
  app.use(unsignedLocalRequestGuard(options))
  app.all("*", (c) => c.json({ served: true }))
  return app
}

describe("deploymentMode", () => {
  test("defaults to self-host when absent or blank (zero-config self-host DX)", () => {
    expect(deploymentMode({})).toBe("local")
    expect(deploymentMode({ [DEPLOYMENT_MODE_ENV]: "" })).toBe("local")
    expect(deploymentMode({ [DEPLOYMENT_MODE_ENV]: "  " })).toBe("local")
  })

  test("accepts the two explicit modes (trimmed, case-insensitive)", () => {
    expect(deploymentMode({ [DEPLOYMENT_MODE_ENV]: "local" })).toBe("local")
    expect(deploymentMode({ [DEPLOYMENT_MODE_ENV]: "hosted" })).toBe("hosted")
    expect(deploymentMode({ [DEPLOYMENT_MODE_ENV]: " Hosted " })).toBe("hosted")
  })

  test("throws on unknown values instead of silently falling open", () => {
    expect(() => deploymentMode({ [DEPLOYMENT_MODE_ENV]: "production" })).toThrowError(DeploymentModeError)
    expect(() => deploymentMode({ [DEPLOYMENT_MODE_ENV]: "production" })).toThrowError(
      /must be "local" or "hosted"; got "production"/,
    )
  })
})

describe("unsignedLocalRequestGuard (the ONE global unsigned-local gate)", () => {
  test("self-host unsigned: loopback requests keep working exactly as today", async () => {
    const app = guardedApp({ mode: "local", authConfig: unsignedLocalConfig })
    for (const url of [
      "http://127.0.0.1/api/control/sessions",
      "http://localhost:3001/api/claxedo/agent-config/commands",
      "http://[::1]/session",
    ]) {
      const res = await app.request(url)
      expect(res.status, url).toBe(200)
      expect(await res.json()).toEqual({ served: true })
    }
  })

  test("self-host unsigned: non-loopback requests are denied by default (403)", async () => {
    const app = guardedApp({ mode: "local", authConfig: unsignedLocalConfig })
    for (const url of [
      "http://cp.example.test/api/control/sessions",
      "http://192.168.1.20:3001/session",
      "http://cp.example.test/api/claxedo/track",
    ]) {
      const res = await app.request(url, { method: url.endsWith("track") ? "POST" : "GET" })
      expect(res.status, url).toBe(403)
      expect(await res.json()).toMatchObject({ error: { code: "unsigned_local_loopback_required" } })
    }
  })

  test("self-host unsigned: loopback Host with a non-loopback Origin stays denied (browser cross-origin posture preserved)", async () => {
    const app = guardedApp({ mode: "local", authConfig: unsignedLocalConfig })
    const res = await app.request("http://127.0.0.1/api/control/sessions", {
      headers: { origin: "https://evil.example.test" },
    })
    expect(res.status).toBe(403)
  })

  test("self-host unsigned: allowlisted machine/callback routes stay reachable non-loopback (their own gates apply)", async () => {
    const app = guardedApp({ mode: "local", authConfig: unsignedLocalConfig })
    for (const [method, url] of [
      ["GET", "http://cp.example.test/api/claxedo/health"],
      ["GET", "http://cp.example.test/global/health"],
      ["GET", "http://cp.example.test/.well-known/jwks.json"],
      ["GET", "http://cp.example.test/api/claxedo/integrations/callback?state=abc"],
      ["GET", "http://cp.example.test/internal/relay/target?workspaceId=ws_1"],
      ["POST", "http://cp.example.test/internal/sandbox-manager/gc"],
      ["POST", "http://cp.example.test/api/channels/telegram"],
    ] as const) {
      const res = await app.request(url, { method })
      expect(res.status, `${method} ${url}`).toBe(200)
    }
  })

  test("self-host unsigned: the allowlist does not leak beyond its exact/method shape", async () => {
    const app = guardedApp({ mode: "local", authConfig: unsignedLocalConfig })
    // POST to a GET-only exact entry, and a non-allowlisted sibling path.
    for (const [method, url] of [
      ["POST", "http://cp.example.test/api/claxedo/health"],
      ["GET", "http://cp.example.test/api/claxedo/integrations/connections/notion/token"],
      ["GET", "http://cp.example.test/api/claxedo/integrations"],
    ] as const) {
      const res = await app.request(url, { method })
      expect(res.status, `${method} ${url}`).toBe(403)
    }
  })

  test("self-host misconfigured: non-loopback answers 503 (signed requested but broken), loopback still passes", async () => {
    const app = guardedApp({ mode: "local", authConfig: misconfiguredConfig })
    const remote = await app.request("http://cp.example.test/api/control/sessions")
    expect(remote.status).toBe(503)
    expect(await remote.json()).toMatchObject({ error: { code: "signed_cloud_auth_disabled" } })
    const local = await app.request("http://127.0.0.1/api/control/sessions")
    expect(local.status).toBe(200)
  })

  test("signed deployment: the guard passes through; per-route bearer verification stays the gate", async () => {
    const app = guardedApp({ mode: "local", authConfig: enabledConfig })
    expect((await app.request("http://cp.example.test/api/control/sessions")).status).toBe(200)
    const hosted = guardedApp({ mode: "hosted", authConfig: enabledConfig })
    expect((await hosted.request("http://cp.example.test/api/control/sessions")).status).toBe(200)
  })

  test("hosted unsigned: EVERYTHING is rejected 503 — loopback, allowlist, all of it (down, not open)", async () => {
    const app = guardedApp({ mode: "hosted", authConfig: unsignedLocalConfig })
    for (const url of [
      "http://cp.example.test/api/control/sessions",
      "http://127.0.0.1/api/control/sessions",
      "http://127.0.0.1/api/claxedo/health",
      "http://cp.example.test/internal/relay/target",
    ]) {
      const res = await app.request(url)
      expect(res.status, url).toBe(503)
      expect(await res.json()).toMatchObject({ error: { code: "hosted_unsigned_rejected" } })
    }
    const misconfigured = guardedApp({ mode: "hosted", authConfig: misconfiguredConfig })
    expect((await misconfigured.request("http://127.0.0.1/api/claxedo/health")).status).toBe(503)
  })

  test("every allowlist entry documents its own gate", () => {
    for (const entry of UNSIGNED_NONLOOPBACK_ALLOWLIST) {
      expect(entry.why.length).toBeGreaterThan(10)
      expect(!!entry.exact || !!entry.prefix).toBe(true)
    }
  })
})

describe("Node composition boot wiring (createDefaultLocalControlPlaneServices)", () => {
  const KEYS = [
    "CLAXEDO_DEPLOYMENT_MODE",
    "CLAXEDO_SIGNED_CLOUD_AUTH",
    "CLAXEDO_WORKSPACE_AUTHORITY_URL",
    "CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN",
    "CLAXEDO_EMBEDDED_AUTH",
  ] as const

  async function withEnv(env: Record<string, string>, run: () => Promise<void> | void) {
    const previous = new Map<string, string | undefined>()
    for (const key of KEYS) {
      previous.set(key, process.env[key])
      delete process.env[key]
    }
    for (const [key, value] of Object.entries(env)) process.env[key] = value
    try {
      await run()
    } finally {
      for (const key of KEYS) {
        const value = previous.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  test("mode=hosted REFUSES to boot in the self-hosted entrypoint", async () => {
    const { createDefaultLocalControlPlaneServices } = await import("../deployments/self-hosted-node/app")
    await withEnv({ CLAXEDO_DEPLOYMENT_MODE: "hosted" }, () => {
      let thrown: Error | undefined
      try {
        createDefaultLocalControlPlaneServices()
      } catch (err) {
        thrown = err as Error
      }
      expect(thrown?.message).toMatch(/not supported by the self-hosted Node entrypoint/)
    })
  })

  test("invalid mode value refuses to boot loudly", async () => {
    const { createDefaultLocalControlPlaneServices } = await import("../deployments/self-hosted-node/app")
    await withEnv({ CLAXEDO_DEPLOYMENT_MODE: "prod" }, () => {
      expect(() => createDefaultLocalControlPlaneServices()).toThrowError(/must be "local" or "hosted"/)
    })
  })
})
