import { afterEach, describe, expect, test } from "vitest"
import { createServer, type Server } from "node:http"
import { once } from "node:events"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { Hono } from "hono"
import {
  ControlPlaneAuthError,
  bearerToken,
  betterAuthAdapter,
  clerkAuthAdapter,
  controlPlaneAuthConfig,
  controlPlaneAuthContext,
  customVerifierAuthAdapter,
  devAuthAdapter,
  localOnlyAuthAdapter,
  signedCloudAuthRequested,
  tokenVerifierAsClerk,
} from "@claxedo/server-core/platform/auth/auth"
import {
  assertHostedBootRequirements,
  deploymentMode,
  unsignedLocalRequestGuard,
} from "../../authority/deployment-mode"

const enabledConfig = {
  enabled: true,
  issuer: "https://clerk.example.test",
  jwksUrl: "https://clerk.example.test/.well-known/jwks.json",
} as const

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function listen(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void) {
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return `http://127.0.0.1:${address.port}`
}

describe("control plane auth", () => {
  test("keeps signed cloud auth disabled unless explicitly configured", () => {
    expect(controlPlaneAuthConfig({})).toEqual({
      enabled: false,
      mode: "local-only",
      reason: "signed/cloud auth is disabled",
    })
  })

  test("requires Clerk and workspace-authority config when signed cloud auth is enabled", () => {
    expect(controlPlaneAuthConfig({ CLAXEDO_SIGNED_CLOUD_AUTH: "true" })).toEqual({
      enabled: false,
      mode: "misconfigured",
      reason: "CLERK_JWT_ISSUER, CLERK_JWKS_URL, and CLAXEDO_WORKSPACE_AUTHORITY_URL are required for signed/cloud auth",
    })
  })

  test("fails closed when the composition reports no workspace authority", () => {
    // auth.ts knows no backend URL env names: the composition root resolves the
    // authority (via the storage adapter) and passes only its presence in.
    expect(controlPlaneAuthConfig({
      CLAXEDO_SIGNED_CLOUD_AUTH: "true",
      CLERK_JWT_ISSUER: "https://clerk.example.test",
      CLERK_JWKS_URL: "https://clerk.example.test/.well-known/jwks.json",
    }, { authorityConfigured: false })).toEqual({
      enabled: false,
      mode: "misconfigured",
      reason: "CLERK_JWT_ISSUER, CLERK_JWKS_URL, and CLAXEDO_WORKSPACE_AUTHORITY_URL are required for signed/cloud auth",
    })
  })

  test("reports whether the deployment requested signed cloud auth", () => {
    expect(signedCloudAuthRequested({})).toBe(false)
    expect(signedCloudAuthRequested({ CLAXEDO_SIGNED_CLOUD_AUTH: "true" })).toBe(true)
    expect(signedCloudAuthRequested({ CLAXEDO_SIGNED_CLOUD_AUTH: "0" })).toBe(false)
  })

  test("builds enabled config from Clerk env and the composed authority presence", () => {
    const env = {
      CLAXEDO_SIGNED_CLOUD_AUTH: "true",
      CLERK_JWT_ISSUER: "https://clerk.example.test",
      CLERK_JWKS_URL: "https://clerk.example.test/.well-known/jwks.json",
      CLERK_JWT_AUDIENCE: "convex",
    }
    const enabled = {
      enabled: true,
      issuer: "https://clerk.example.test",
      jwksUrl: "https://clerk.example.test/.well-known/jwks.json",
      audience: "convex",
    }
    expect(controlPlaneAuthConfig(env, { authorityConfigured: true })).toEqual(enabled)
    // Callers that cannot assert authority presence (per-request ambient config)
    // stay enabled: the composition roots fail closed at boot instead.
    expect(controlPlaneAuthConfig(env)).toEqual(enabled)
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

  test("builds Clerk auth adapter from env and an optional verifier", async () => {
    const adapter = clerkAuthAdapter({
      env: {
        CLAXEDO_SIGNED_CLOUD_AUTH: "true",
        CLERK_JWT_ISSUER: "https://clerk.example.test",
        CLERK_JWKS_URL: "https://clerk.example.test/.well-known/jwks.json",
      },
      authorityConfigured: true,
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
        issuer: "https://clerk.example.test",
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
    const verifier = tokenVerifierAsClerk({
      verify: async () => ({
        subject: "user_1",
        scopes: [],
        claims: {
          jti: tokenIds.shift(),
        },
      }),
    })

    const first = await verifier("first", enabledConfig)
    const second = await verifier("second", enabledConfig)

    expect(first.user.tokenIdentifier).toBe(`${enabledConfig.issuer}|user_1`)
    expect(second.user.tokenIdentifier).toBe(first.user.tokenIdentifier)
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

  test("delegates valid bearer verification to the configured Clerk verifier", async () => {
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
        tokenIdentifier: "https://clerk.example.test|tok_123",
        issuer: "https://clerk.example.test",
      },
    })
  })

  test("verifies current and legacy organization claims through the configured remote Clerk JWKS", async () => {
    const keys = await generateKeyPair("EdDSA", { extractable: true })
    const jwk = {
      ...await exportJWK(keys.publicKey),
      alg: "EdDSA",
      kid: "clerk_test_key",
      use: "sig",
    }
    const issuer = await listen((req, res) => {
      if (req.url !== "/.well-known/jwks.json") {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ keys: [jwk] }))
    })
    const legacyToken = await new SignJWT({ org_id: "org_1" })
      .setProtectedHeader({ alg: "EdDSA", kid: "clerk_test_key" })
      .setIssuedAt()
      .setIssuer(issuer)
      .setAudience("convex")
      .setSubject("user_1")
      .setExpirationTime("2m")
      .sign(keys.privateKey)
    const currentToken = await new SignJWT({ o: { id: "org_1", rol: "admin", slg: "example" } })
      .setProtectedHeader({ alg: "EdDSA", kid: "clerk_test_key" })
      .setIssuedAt()
      .setIssuer(issuer)
      .setAudience("convex")
      .setSubject("user_1")
      .setExpirationTime("2m")
      .sign(keys.privateKey)

    for (const token of [legacyToken, currentToken]) {
      await expect(controlPlaneAuthContext(new Request("http://localhost", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }), {
        config: {
          enabled: true,
          issuer,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          audience: "convex",
        },
      })).resolves.toEqual({
        mode: "signed",
        token,
        user: {
          subject: "user_1",
          tokenIdentifier: `${issuer}|user_1`,
          issuer,
          audience: "convex",
          orgId: "org_1",
        },
      })
    }
  })
})

// Hosted deployment mode must be fail-closed at boot (every missing piece
// named); absent mode must keep the
// self-host zero-config posture byte-for-byte; and the global unsigned-local
// guard is the PRIMARY gate over the per-route loopback checks.
describe("deployment mode matrix", () => {
  const hostedEnv = {
    CLAXEDO_DEPLOYMENT_MODE: "hosted",
    CLAXEDO_SIGNED_CLOUD_AUTH: "true",
    CLERK_JWT_ISSUER: "https://clerk.example.test",
    CLERK_JWKS_URL: "https://clerk.example.test/.well-known/jwks.json",
    CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-token",
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: "private-key",
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: "public-key",
  }

  test("hosted + complete config boots with signed auth enabled and unsigned-local unreachable", async () => {
    expect(() => assertHostedBootRequirements(hostedEnv, { authorityConfigured: true })).not.toThrow()
    const config = controlPlaneAuthConfig(hostedEnv, { authorityConfigured: true })
    expect(config).toEqual(enabledConfig)
    // With the booted config, a bearer-less request can NEVER be served as
    // unsigned-local — it is a 401, not a pass-through.
    await expect(controlPlaneAuthContext(new Request("http://localhost"), { config })).rejects.toMatchObject({
      status: 401,
      code: "missing_bearer_token",
    } satisfies Partial<ControlPlaneAuthError>)
  })

  test.each([
    ["CLAXEDO_SIGNED_CLOUD_AUTH", /CLAXEDO_SIGNED_CLOUD_AUTH=true/],
    ["CLERK_JWT_ISSUER", /CLERK_JWT_ISSUER/],
    ["CLERK_JWKS_URL", /CLERK_JWKS_URL/],
    ["CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", /CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN/],
    ["CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM", /CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM/],
    ["CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM", /CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM/],
  ] as const)("hosted missing %s refuses to boot naming the piece", (key, named) => {
    expect(() =>
      assertHostedBootRequirements({ ...hostedEnv, [key]: undefined }, { authorityConfigured: true }),
    ).toThrowError(named)
  })

  test("hosted without a workspace authority refuses to boot naming the piece", () => {
    expect(() => assertHostedBootRequirements(hostedEnv, { authorityConfigured: false })).toThrowError(
      /CLAXEDO_WORKSPACE_AUTHORITY_URL/,
    )
  })

  test("absent mode = self-host: auth config resolution is byte-for-byte today's behavior", async () => {
    expect(deploymentMode({})).toBe("local")
    // Zero-config env resolves the exact same unsigned-local pass-through.
    const config = controlPlaneAuthConfig({})
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
