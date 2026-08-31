import { describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import {
  ControlPlaneAuthError,
  bearerToken,
  betterAuthAdapter,
  controlPlaneAuthContext,
  customVerifierAuthAdapter,
  devAuthAdapter,
  localOnlyAuthAdapter,
} from "@claxedo/server-core/platform/auth/auth"
import { controlPlaneAuthConfig } from "@claxedo/server-core/platform/auth/auth"
import { isCliAccessTokenCandidate } from "@claxedo/server-core/platform/auth/cli-session-token"
import {
  deploymentMode,
  unsignedLocalRequestGuard,
} from "@claxedo/server-core/authority/deployment-mode"

const enabledConfig = {
  enabled: true,
  adapter: "custom",
  issuer: "https://idp.example.test",
  jwksUrl: "https://idp.example.test/.well-known/jwks.json",
} as const

function untrustedJwt(payload: Record<string, unknown>) {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "untrusted-signature",
  ].join(".")
}

describe("control plane auth", () => {
  test("stays local-only by default; signed deployments compose an explicit adapter", () => {
    expect(controlPlaneAuthConfig()).toEqual({
      enabled: false,
      mode: "local-only",
      reason: "signed/cloud auth is disabled",
    })
  })

  test("accepts bearer tokens only from the Authorization header shape", () => {
    expect(bearerToken("Bearer tok_123")).toBe("tok_123")
    expect(bearerToken("bearer tok_123")).toBe("tok_123")
    expect(bearerToken("Basic tok_123")).toBeUndefined()
    expect(bearerToken(null)).toBeUndefined()
  })

  test("returns unsigned local context when signed cloud auth is disabled", async () => {
    await expect(controlPlaneAuthContext(new Request("http://localhost"), {
      config: {
        enabled: false,
        mode: "local-only",
        reason: "disabled for local mode",
      },
    })).resolves.toEqual({
      mode: "unsigned-local",
      reason: "disabled for local mode",
    })
  })

  test("builds local and dev auth adapters for unsigned local control planes", async () => {
    await expect(
      controlPlaneAuthContext(new Request("http://localhost"), localOnlyAuthAdapter("local dev")),
    ).resolves.toEqual({
      mode: "unsigned-local",
      reason: "local dev",
    })
    expect(devAuthAdapter("dev server").config).toEqual({
      enabled: false,
      mode: "local-only",
      reason: "dev server",
    })
  })

  test("builds an explicit adapter from a composed verifier", async () => {
    const adapter = customVerifierAuthAdapter({
      issuer: "https://idp.example.test",
      verifier: async (token, config) => ({
        mode: "signed",
        user: {
          subject: token,
          tokenIdentifier: `${config.issuer}|${token}`,
          issuer: config.issuer,
        },
      }),
    })

    await expect(controlPlaneAuthContext(
      new Request("http://localhost", {
        headers: { Authorization: "Bearer user_1" },
      }),
      adapter,
    )).resolves.toMatchObject({
      mode: "signed",
      user: {
        subject: "user_1",
        issuer: "https://idp.example.test",
      },
    })
  })

  test("builds custom verifier auth adapter without exposing provider details to callers", async () => {
    const adapter = customVerifierAuthAdapter({
      issuer: "https://idp.example.test",
      verifier: async (token, config) => ({
        mode: "signed",
        user: {
          subject: token,
          tokenIdentifier: `${config.issuer}|${token}`,
          issuer: config.issuer,
        },
      }),
    })

    await expect(controlPlaneAuthContext(
      new Request("http://localhost", {
        headers: { Authorization: "Bearer user_1" },
      }),
      adapter,
    )).resolves.toMatchObject({
      mode: "signed",
      user: {
        subject: "user_1",
        tokenIdentifier: "https://idp.example.test|user_1",
      },
    })
  })

  test("normalizes Better Auth-style session verification into signed control-plane auth", async () => {
    const adapter = betterAuthAdapter({
      issuer: "https://better-auth.example.test",
      audience: "control-plane",
      verifier: async () => ({
        user: { id: "user_1" },
        session: { id: "session_1" },
        organizationId: "org_1",
      }),
    })

    await expect(controlPlaneAuthContext(
      new Request("http://localhost", {
        headers: { Authorization: "Bearer better_token" },
      }),
      adapter,
    )).resolves.toEqual({
      mode: "signed",
      token: "better_token",
      user: {
        subject: "user_1",
        tokenIdentifier: "https://better-auth.example.test|user_1",
        issuer: "https://better-auth.example.test",
        audience: "control-plane",
        orgId: "org_1",
      },
    })
  })

  test("keeps the authority principal stable across Better Auth sessions", async () => {
    const sessions = ["session_1", "session_2"]
    const adapter = betterAuthAdapter({
      issuer: "https://better-auth.example.test",
      verifier: async () => ({
        user: { id: "user_1" },
        session: { id: sessions.shift() },
      }),
    })

    const first = await controlPlaneAuthContext(
      new Request("http://localhost", { headers: { Authorization: "Bearer first" } }),
      adapter,
    )
    const second = await controlPlaneAuthContext(
      new Request("http://localhost", { headers: { Authorization: "Bearer second" } }),
      adapter,
    )

    expect(first).toMatchObject({
      user: { tokenIdentifier: "https://better-auth.example.test|user_1" },
    })
    expect(second).toMatchObject({
      user: { tokenIdentifier: "https://better-auth.example.test|user_1" },
    })
  })

  test("keeps the authority principal stable across tokens from a unified verifier", async () => {
    const tokenIds = ["token_1", "token_2"]
    const adapter = customVerifierAuthAdapter({
      issuer: enabledConfig.issuer,
      verifier: async () => ({
        mode: "signed" as const,
        user: {
          subject: "user_1",
          tokenIdentifier: `${enabledConfig.issuer}|user_1`,
          issuer: enabledConfig.issuer,
        },
      }),
    })

    const first = await controlPlaneAuthContext(
      new Request("http://localhost", { headers: { Authorization: "Bearer first" } }),
      adapter,
    )
    const second = await controlPlaneAuthContext(
      new Request("http://localhost", { headers: { Authorization: "Bearer second" } }),
      adapter,
    )

    expect(tokenIds).toEqual(["token_1", "token_2"])
    expect(first).toMatchObject({ user: { tokenIdentifier: `${enabledConfig.issuer}|user_1` } })
    expect(second).toMatchObject({ user: { tokenIdentifier: `${enabledConfig.issuer}|user_1` } })
  })

  test("marks a verified Clerk OAuth token for the service authority path", async () => {
    const verifier = tokenVerifierAsClerk({
      verify: async () => ({
        subject: "user_1",
        scopes: ["openid"],
        claims: { client_id: "desktop_client" },
      }),
    })

    await expect(verifier("oauth-token", {
      ...enabledConfig,
      oauthClientId: "desktop_client",
    })).resolves.toMatchObject({
      tokenKind: "clerk-oauth",
      user: { tokenIdentifier: `${enabledConfig.issuer}|user_1` },
    })
  })

  test("rejects a Clerk OAuth token issued to another client", async () => {
    const verifier = tokenVerifierAsClerk({
      verify: async () => ({
        subject: "user_1",
        scopes: ["openid"],
        claims: { client_id: "other_client" },
      }),
    })

    await expect(verifier("oauth-token", {
      ...enabledConfig,
      oauthClientId: "desktop_client",
    })).rejects.toThrow("unrecognized client")
  })

  test("fails closed when signed cloud auth is enabled but misconfigured", async () => {
    await expect(controlPlaneAuthContext(new Request("http://localhost"), {
      config: {
        enabled: false,
        mode: "misconfigured",
        reason: "missing config",
      },
    })).rejects.toMatchObject({
      status: 503,
      code: "signed_cloud_auth_disabled",
      message: "missing config",
    } satisfies Partial<ControlPlaneAuthError>)
  })

  test("rejects missing bearer token when signed cloud auth is enabled", async () => {
    await expect(controlPlaneAuthContext(new Request("http://localhost"), {
      config: enabledConfig,
    })).rejects.toMatchObject({
      status: 401,
      code: "missing_bearer_token",
    } satisfies Partial<ControlPlaneAuthError>)
  })

  test("never routes a CLI-shaped credential around the selected Better Auth verifier", async () => {
    const providerVerifier = vi.fn(async () => null)
    const adapter = betterAuthAdapter({
      issuer: "https://auth.example.test",
      audience: "https://api.example.test",
      verifier: providerVerifier,
    })
    const candidate = untrustedJwt({ claxedo_token_kind: "claxedo_cli_access" })

    await expect(controlPlaneAuthContext(new Request("https://api.example.test", {
      headers: { authorization: `Bearer ${candidate}` },
    }), adapter)).rejects.toMatchObject({ status: 401, code: "invalid_bearer_token" })
    expect(providerVerifier).toHaveBeenCalledTimes(1)
    expect(providerVerifier).toHaveBeenCalledWith(candidate)
  })

  test("preserves verifier rejection versus verifier unavailability", async () => {
    const request = new Request("https://api.example.test", {
      headers: { authorization: "Bearer credential" },
    })

    await expect(controlPlaneAuthContext(request.clone(), {
      config: { ...enabledConfig, adapter: "custom" },
      verifier: async () => {
        throw new ControlPlaneAuthError(401, "invalid_bearer_token", "rejected")
      },
    })).rejects.toMatchObject({ status: 401, code: "invalid_bearer_token" })

    await expect(controlPlaneAuthContext(request.clone(), {
      config: { ...enabledConfig, adapter: "custom" },
      verifier: async () => {
        throw new Error("sensitive upstream detail")
      },
    })).rejects.toEqual(
      new ControlPlaneAuthError(503, "auth_verifier_unavailable", "Authentication verifier is unavailable"),
    )
  })

  test("delegates valid bearer verification to the configured verifier", async () => {
    await expect(controlPlaneAuthContext(new Request("http://localhost", {
      headers: {
        Authorization: "Bearer tok_123",
      },
    }), {
      config: enabledConfig,
      verifier: async (token, config) => ({
        mode: "signed",
        user: {
          subject: token,
          tokenIdentifier: `${config.issuer}|${token}`,
          issuer: config.issuer,
        },
      }),
    })).resolves.toEqual({
      mode: "signed",
      token: "tok_123",
      user: {
        subject: "tok_123",
        tokenIdentifier: "https://idp.example.test|tok_123",
        issuer: "https://idp.example.test",
      },
    })
  })
})

// Absent mode must keep the self-host zero-config posture byte-for-byte, and
// the global unsigned-local guard is the PRIMARY gate over the per-route
// loopback checks.
describe("deployment mode matrix", () => {
  test("an enabled signed config makes unsigned-local unreachable", async () => {
    // Signed deployments compose an explicit adapter; the neutral default
    // stays local-only. With an enabled config, a bearer-less request can
    // NEVER be served as unsigned-local — it is a 401, not a pass-through.
    const config = enabledConfig
    await expect(controlPlaneAuthContext(new Request("http://localhost"), { config })).rejects.toMatchObject({
      status: 401,
      code: "missing_bearer_token",
    } satisfies Partial<ControlPlaneAuthError>)
  })

  test("absent mode = self-host: auth config resolution is byte-for-byte today's behavior", async () => {
    expect(deploymentMode({})).toBe("local")
    // Zero-config env resolves the exact same unsigned-local pass-through.
    const config = controlPlaneAuthConfig()
    expect(config).toEqual({
      enabled: false,
      mode: "local-only",
      reason: "signed/cloud auth is disabled",
    })
    await expect(controlPlaneAuthContext(new Request("http://localhost"), { config })).resolves.toEqual({
      mode: "unsigned-local",
      reason: "signed/cloud auth is disabled",
    })
  })

  function guardedApp(mode: "local" | "hosted", authConfig: Parameters<typeof unsignedLocalRequestGuard>[0]["authConfig"]) {
    const app = new Hono()
    app.use(unsignedLocalRequestGuard({ mode, authConfig }))
    app.all("*", (c) => c.json({ served: true }))
    return app
  }

  test("global guard rejects non-loopback unsigned in self-host; loopback keeps working", async () => {
    const app = guardedApp("local", {
      enabled: false,
      mode: "local-only",
      reason: "signed/cloud auth is disabled",
    })
    expect((await app.request("http://127.0.0.1/api/control/sessions")).status).toBe(200)
    const remote = await app.request("http://cp.example.test/api/control/sessions")
    expect(remote.status).toBe(403)
    expect(await remote.json()).toMatchObject({ error: { code: "unsigned_local_loopback_required" } })
  })

  test("global guard rejects EVERYTHING unsigned in hosted, loopback included", async () => {
    const app = guardedApp("hosted", {
      enabled: false,
      mode: "local-only",
      reason: "signed/cloud auth is disabled",
    })
    for (const url of ["http://127.0.0.1/api/control/sessions", "http://cp.example.test/api/control/sessions"]) {
      const res = await app.request(url)
      expect(res.status, url).toBe(503)
      expect(await res.json()).toMatchObject({ error: { code: "hosted_unsigned_rejected" } })
    }
  })

  test("global guard passes signed deployments through to per-route bearer verification", async () => {
    const app = guardedApp("hosted", enabledConfig)
    expect((await app.request("http://cp.example.test/api/control/sessions")).status).toBe(200)
  })
})
