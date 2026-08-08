import { describe, expect, test } from "vitest"
import { Hono } from "hono"
import {
  DEPLOYMENT_MODE_ENV,
  DeploymentModeError,
  UNSIGNED_NONLOOPBACK_ALLOWLIST,
  assertHostedBootRequirements,
  deploymentMode,
  hostedBootRequirementFailures,
  unsignedLocalRequestGuard,
} from "@claxedo/server-core/authority/deployment-mode"
import type { ControlPlaneAuthConfig } from "@claxedo/server-core/platform/auth/auth"

/**
 * Deployment mode and the global unsigned-local gate.
 * These tests cover mode parsing, hosted fail-closed boot requirements, and the
 * guard's request-time policy. In-process Requests carry no transport peer,
 * so `isLoopbackLocalRequest` falls back to the Host/Origin classification:
 * `http://127.0.0.1/...` = loopback, `http://cp.example.test/...` = remote —
 * the same fallback every other in-process test in this package relies on.
 */

const hostedCompleteEnv = {
  CLAXEDO_DEPLOYMENT_MODE: "hosted",
  CLAXEDO_SIGNED_CLOUD_AUTH: "true",
  CLERK_JWT_ISSUER: "https://clerk.example.test",
  CLERK_JWKS_URL: "https://clerk.example.test/.well-known/jwks.json",
  CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-token",
  CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: "private-key",
  CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: "public-key",
}

const unsignedLocalConfig: ControlPlaneAuthConfig = {
  enabled: false,
  mode: "local-only",
  reason: "signed/cloud auth is disabled",
}

const misconfiguredConfig: ControlPlaneAuthConfig = {
  enabled: false,
  mode: "misconfigured",
  reason: "CLERK_JWT_ISSUER, CLERK_JWKS_URL, and CLAXEDO_WORKSPACE_AUTHORITY_URL are required for signed/cloud auth",
}

const enabledConfig: ControlPlaneAuthConfig = {
  enabled: true,
  issuer: "https://clerk.example.test",
  jwksUrl: "https://clerk.example.test/.well-known/jwks.json",
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

describe("hosted boot requirements (fail-closed boot)", () => {
  test("hosted + complete config boots (no failures, no throw)", () => {
    expect(hostedBootRequirementFailures(hostedCompleteEnv, { authorityConfigured: true })).toEqual([])
    expect(() => assertHostedBootRequirements(hostedCompleteEnv, { authorityConfigured: true })).not.toThrow()
  })

  test.each([
    ["CLAXEDO_SIGNED_CLOUD_AUTH", /signed cloud auth is not enabled \(set CLAXEDO_SIGNED_CLOUD_AUTH=true\)/],
    ["CLERK_JWT_ISSUER", /no signed-auth token issuer \(set CLERK_JWT_ISSUER\)/],
    ["CLERK_JWKS_URL", /no signed-auth JWKS URL \(set CLERK_JWKS_URL\)/],
    ["CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", /no Control Plane service token \(set CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN\)/],
    ["CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM", /no Runtime Access Token signing private key/],
    ["CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM", /no Runtime Access Token verification public key/],
  ] as const)("hosted missing %s refuses to start naming the piece", (key, message) => {
    const env = { ...hostedCompleteEnv, [key]: undefined }
    expect(() => assertHostedBootRequirements(env, { authorityConfigured: true })).toThrowError(message)
  })

  test("hosted without a composed workspace authority refuses to start naming the piece", () => {
    expect(() => assertHostedBootRequirements(hostedCompleteEnv, { authorityConfigured: false })).toThrowError(
      /no workspace authority \(set CLAXEDO_WORKSPACE_AUTHORITY_URL\)/,
    )
  })

  test("CLERK_ISSUER_URL is accepted as the issuer alias", () => {
    const env = { ...hostedCompleteEnv, CLERK_JWT_ISSUER: undefined, CLERK_ISSUER_URL: "https://clerk.example.test" }
    expect(hostedBootRequirementFailures(env, { authorityConfigured: true })).toEqual([])
  })

  test("hosted + embedded self-host auth is a hard conflict", () => {
    const env = { ...hostedCompleteEnv, CLAXEDO_EMBEDDED_AUTH: "1" }
    expect(() => assertHostedBootRequirements(env, { authorityConfigured: true })).toThrowError(
      /unset CLAXEDO_EMBEDDED_AUTH/,
    )
  })

  test("hosted rejects unsupported Runtime Access Token algorithms", () => {
    expect(() => assertHostedBootRequirements({
      ...hostedCompleteEnv,
      CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM: "RS256",
    }, { authorityConfigured: true })).toThrowError(/must be EdDSA/)
  })

  test("ONE error names EVERY missing piece (no one-piece-per-restart loops)", () => {
    let thrown: DeploymentModeError | undefined
    try {
      assertHostedBootRequirements({ CLAXEDO_DEPLOYMENT_MODE: "hosted" }, { authorityConfigured: false })
    } catch (err) {
      thrown = err as DeploymentModeError
    }
    expect(thrown).toBeInstanceOf(DeploymentModeError)
    expect(thrown?.code).toBe("hosted_boot_requirements_missing")
    expect(thrown?.message).toMatch(/CLAXEDO_SIGNED_CLOUD_AUTH=true/)
    expect(thrown?.message).toMatch(/CLERK_JWT_ISSUER/)
    expect(thrown?.message).toMatch(/CLERK_JWKS_URL/)
    expect(thrown?.message).toMatch(/CLAXEDO_WORKSPACE_AUTHORITY_URL/)
    expect(thrown?.message).toMatch(/CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN/)
    expect(thrown?.message).toMatch(/CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM/)
    expect(thrown?.message).toMatch(/CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM/)
  })

  describe("hosted credential backend", () => {
    const withCreds = {
      ...hostedCompleteEnv,
      CLAXEDO_HOSTED_CREDENTIALS_ENABLED: "1",
      CLAXEDO_CF_KV_URL: "https://kv.example.test/ns",
      CLAXEDO_CF_KV_TOKEN: "kv_token",
      CLAXEDO_CREDENTIALS_KEK: "a".repeat(44),
    }

    test("does not require the credential backend when hosted credentials are disabled", () => {
      expect(hostedBootRequirementFailures(hostedCompleteEnv, { authorityConfigured: true })).toEqual([])
    })

    test("flag ON + complete encrypted-KV config boots", () => {
      expect(hostedBootRequirementFailures(withCreds, { authorityConfigured: true })).toEqual([])
      expect(() => assertHostedBootRequirements(withCreds, { authorityConfigured: true })).not.toThrow()
    })

    test.each([
      ["CLAXEDO_CF_KV_URL", /no encrypted-KV backend \(set CLAXEDO_CF_KV_URL/],
      ["CLAXEDO_CF_KV_TOKEN", /KV byte store has no token \(set CLAXEDO_CF_KV_TOKEN\)/],
      ["CLAXEDO_CREDENTIALS_KEK", /envelope encryption key is absent \(set CLAXEDO_CREDENTIALS_KEK/],
    ] as const)("flag ON but missing %s refuses to start (else it silently uses the local file store)", (key, message) => {
      const env = { ...withCreds, [key]: undefined }
      expect(() => assertHostedBootRequirements(env, { authorityConfigured: true })).toThrowError(message)
    })

    test("flag ON with no credential backend at all names all three pieces at once", () => {
      const env = { ...hostedCompleteEnv, CLAXEDO_HOSTED_CREDENTIALS_ENABLED: "true" }
      let thrown: DeploymentModeError | undefined
      try {
        assertHostedBootRequirements(env, { authorityConfigured: true })
      } catch (err) {
        thrown = err as DeploymentModeError
      }
      expect(thrown).toBeInstanceOf(DeploymentModeError)
      expect(thrown?.message).toMatch(/CLAXEDO_CF_KV_URL/)
      expect(thrown?.message).toMatch(/CLAXEDO_CF_KV_TOKEN/)
      expect(thrown?.message).toMatch(/CLAXEDO_CREDENTIALS_KEK/)
    })
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
    "CLERK_JWT_ISSUER",
    "CLERK_ISSUER_URL",
    "CLERK_JWKS_URL",
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

  test("mode=hosted with missing pieces REFUSES to boot, naming every piece", async () => {
    const { createDefaultLocalControlPlaneServices } = await import("../deployments/self-hosted-node/app")
    await withEnv({ CLAXEDO_DEPLOYMENT_MODE: "hosted" }, () => {
      let thrown: Error | undefined
      try {
        createDefaultLocalControlPlaneServices()
      } catch (err) {
        thrown = err as Error
      }
      expect(thrown).toBeInstanceOf(DeploymentModeError)
      expect(thrown?.message).toMatch(/refuses to start/)
      expect(thrown?.message).toMatch(/CLAXEDO_SIGNED_CLOUD_AUTH=true/)
      expect(thrown?.message).toMatch(/CLERK_JWT_ISSUER/)
      expect(thrown?.message).toMatch(/CLERK_JWKS_URL/)
      expect(thrown?.message).toMatch(/CLAXEDO_WORKSPACE_AUTHORITY_URL/)
      expect(thrown?.message).toMatch(/CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN/)
    })
  })

  test("mode=hosted with signed auth but no authority refuses to boot naming ONLY the authority", async () => {
    const { createDefaultLocalControlPlaneServices } = await import("../deployments/self-hosted-node/app")
    await withEnv(
      {
        CLAXEDO_DEPLOYMENT_MODE: "hosted",
        CLAXEDO_SIGNED_CLOUD_AUTH: "true",
        CLERK_JWT_ISSUER: "https://clerk.example.test",
        CLERK_JWKS_URL: "https://clerk.example.test/.well-known/jwks.json",
        CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-token",
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: "private-key",
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: "public-key",
      },
      () => {
        let thrown: Error | undefined
        try {
          createDefaultLocalControlPlaneServices()
        } catch (err) {
          thrown = err as Error
        }
        expect(thrown?.message).toMatch(/no workspace authority/)
        expect(thrown?.message).not.toMatch(/CLERK_JWKS_URL/)
      },
    )
  })

  test("invalid mode value refuses to boot loudly", async () => {
    const { createDefaultLocalControlPlaneServices } = await import("../deployments/self-hosted-node/app")
    await withEnv({ CLAXEDO_DEPLOYMENT_MODE: "prod" }, () => {
      expect(() => createDefaultLocalControlPlaneServices()).toThrowError(/must be "local" or "hosted"/)
    })
  })
})
