import { describe, expect, test } from "vitest"
import { Hono } from "hono"
import type { ControlPlaneAuthConfig } from "@claxedo/server-core/platform/auth/auth"
import { createProviderAuthService } from "../../credentials/provider-auth/service"
import { ProviderAuthRoutes } from "../../credentials/routes/provider-auth"

const service = createProviderAuthService({} as never)

// A ClaxedoControlPlane route (route-ownership.ts) mounted with no auth options
// is invisible under unsigned-local — the global `unsignedLocalRequestGuard` is
// the gate there — and wide open the moment signed auth is enabled, because that
// guard returns `next()` immediately when `authConfig.enabled` and hands the job
// to per-route verification that did not exist. A box enables signed auth
// specifically to be reachable remotely, so that is exactly when the protection
// disappears.
//
// `LivingAppsRoutes` was the other instance of this class; the route has since
// been removed from the tree, so `provider-auth` and `client-presentation` are what
// remain to hold — the latter in `client-presentation-auth-gate.test.ts`. The
// structural guard against a *future* ungated mount lives in
// architecture.test.ts — this file covers the runtime behaviour.

const signedConfig: ControlPlaneAuthConfig = {
  enabled: true,
  issuer: "https://example.issuer.dev",
  jwksUrl: "https://example.issuer.dev/.well-known/jwks.json",
  audience: "claxedo-server",
}

const unsignedLocalConfig: ControlPlaneAuthConfig = {
  enabled: false,
  mode: "local-only",
  reason: "signed/cloud auth is disabled",
}

const misconfiguredConfig: ControlPlaneAuthConfig = {
  enabled: false,
  mode: "misconfigured",
  reason: "an issuer, a JWKS URL, and CLAXEDO_WORKSPACE_AUTHORITY_URL are required for signed/cloud auth",
}

describe("provider-auth gate (signed mode)", () => {
  // Higher stakes than a plain read route: the OAuth callback calls
  // deleteCredentialsByProvider + putCredential, so an unauthenticated caller
  // could replace a box's provider credentials with their own.
  // Signed mode always composes a verifier; these tests use one that refuses
  // every token, which is what a malformed bearer meets in production.
  const refusingVerifier = async () => {
    throw Object.assign(new Error("Bearer token is invalid"), { status: 401 })
  }

  function mountProvider(config: ControlPlaneAuthConfig, verifier: typeof refusingVerifier | null = refusingVerifier) {
    const app = new Hono()
    app.route("/", ProviderAuthRoutes({ service, authConfig: config, ...(verifier ? { verifier: verifier as never } : {}) }))
    return app
  }

  // Every method/path shape the router exposes, so a future route added without
  // the gate is caught rather than silently joining an already-passing suite.
  const PROVIDER_SURFACES: Array<[string, string]> = [
    ["GET", "/provider/auth"],
    ["POST", "/provider/anthropic/oauth/authorize"],
    ["POST", "/provider/anthropic/oauth/callback"],
  ]

  test.each(PROVIDER_SURFACES)("%s %s refuses an unauthenticated request", async (method, path) => {
    const res = await mountProvider(signedConfig).request(path, {
      method,
      ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
    })
    // 401 from the gate — never 200/201, and never a 400 body-validation error,
    // which would mean the request reached the handler before being rejected.
    expect(res.status).toBe(401)
  })

  test("refuses a malformed bearer token rather than falling through", async () => {
    const res = await mountProvider(signedConfig).request("/provider/auth", {
      headers: { authorization: "Bearer not-a-real-jwt" },
    })
    expect(res.status).toBeGreaterThanOrEqual(401)
    expect(res.status).toBeLessThan(500)
  })

  test("the credential-writing callback is gated before it reaches the service", async () => {
    const res = await mountProvider(signedConfig).request("/provider/anthropic/oauth/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: 0, code: "attacker-code" }),
    })
    expect(res.status).toBe(401)
  })

  test("the refusal codes describe what actually happened", async () => {
    // The gate's two signed-mode refusals must stay distinguishable: a caller
    // that sent nothing is told the token is missing, one that sent something
    // unverifiable is told it is invalid.
    const app = mountProvider(signedConfig)
    const missing = await app.request("/provider/auth")
    expect(await missing.json()).toMatchObject({ error: { code: "missing_bearer_token" } })
    const invalid = await app.request("/provider/auth", { headers: { authorization: "Bearer nope" } })
    expect(await invalid.json()).toMatchObject({ error: { code: "invalid_bearer_token" } })
  })

  test("a signed composition without a verifier fails closed and says so", async () => {
    const res = await mountProvider(signedConfig, null).request("/provider/auth", {
      headers: { authorization: "Bearer nope" },
    })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: "auth_verifier_unavailable" } })
  })
})

// In unsigned-local (`CLAXEDO_SIGNED_CLOUD_AUTH` unset) this gate cannot
// evaluate a bearer at all: `controlPlaneAuthContext` short-circuits on
// `!config.enabled` and returns `unsigned-local`, so no token can ever produce
// `mode === "signed"`.
//
// The real gate in this posture is the global `unsignedLocalRequestGuard`
// (loopback-only, 403 `unsigned_local_loopback_required` off-box). So the
// bearer is ignored here, matching `network-policy.ts`'s `routeAuth`, which
// already resolves the same case to an anonymous pass. Two postures must not
// change: `misconfigured` still fails closed with 503, and signed mode still
// requires a verified identity (above).
describe("provider-auth gate (unsigned local)", () => {
  function mountProvider(config: ControlPlaneAuthConfig) {
    const app = new Hono()
    app.route("/", ProviderAuthRoutes({ service, authConfig: config }))
    return app
  }

  test("an anonymous request is served", async () => {
    const res = await mountProvider(unsignedLocalConfig).request("http://localhost:3001/provider/auth")
    expect(res.status).toBe(200)
  })

  test.each([
    ["the app's synthetic e2e token", "test-bypass-token"],
    ["a stale session token", "eyJhbGciOiJSUzI1NiJ9.stale.signature"],
    ["an opaque garbage token", "not-a-real-jwt"],
  ])("a request carrying %s is served identically", async (_label, token) => {
    const app = mountProvider(unsignedLocalConfig)
    const anonymous = await app.request("http://localhost:3001/provider/auth")
    const withBearer = await app.request("http://localhost:3001/provider/auth", {
      headers: { authorization: `Bearer ${token}` },
    })

    // Presenting MORE credentials must never be less permissive than presenting
    // none, and the response must be the same one — not a differently-shaped
    // success that happens to share a status code.
    expect(withBearer.status).toBe(200)
    expect(await withBearer.json()).toEqual(await anonymous.json())
  })

  test("a misconfigured signed deployment still fails closed, bearer or not", async () => {
    const app = mountProvider(misconfiguredConfig)
    for (const init of [{}, { headers: { authorization: "Bearer anything" } }]) {
      const res = await app.request("http://localhost:3001/provider/auth", init)
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ error: { code: "signed_cloud_auth_disabled" } })
    }
  })
})
