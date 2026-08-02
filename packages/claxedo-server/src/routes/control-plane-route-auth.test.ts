import { afterAll, describe, expect, test } from "vitest"
import { Hono } from "hono"
import { mkdirSync, realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

// Point the data dir at a temp root BEFORE importing the route module: it pulls
// in ClaxedoDB, which opens (and migrates) the database on first use. Without
// this the cases below run migrations against the developer's real
// ~/.claxedo/claxedo.db. Same idiom as session-meta.test.ts.
const root = path.join(realpathSync(os.tmpdir()), `control-plane-route-auth-${randomUUID().slice(0, 8)}`)
const prev = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
}
mkdirSync(root, { recursive: true })
process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

const { ProviderAuthRoutes } = await import("./provider-auth")
type ControlPlaneAuthConfig = import("../authority/auth").ControlPlaneAuthConfig

afterAll(async () => {
  process.env.CLAXEDO_DATA_DIR = prev.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_STATE_DIR = prev.CLAXEDO_STATE_DIR
  await fs.rm(root, { recursive: true, force: true })
})

// A ClaxedoControlPlane route (route-ownership.ts) mounted with no auth options
// is invisible under unsigned-local — the global `unsignedLocalRequestGuard` is
// the gate there — and wide open the moment signed auth is enabled, because that
// guard returns `next()` immediately when `authConfig.enabled` and hands the job
// to per-route verification that did not exist. Self-host boxes enable signed
// auth (`CLAXEDO_EMBEDDED_AUTH=1`) specifically to be reachable remotely, so
// that is exactly when the protection disappears.
//
// `LivingAppsRoutes` was the other instance of this class; the route has since
// been removed from the tree, so `provider-auth` and `opencode-compat` are what
// remain to hold — the latter in `opencode-compat-auth-gate.test.ts`. The
// structural guard against a *future* ungated mount lives in
// architecture.test.ts — this file covers the runtime behaviour.

const signedConfig: ControlPlaneAuthConfig = {
  enabled: true,
  issuer: "https://example.clerk.dev",
  jwksUrl: "https://example.clerk.dev/.well-known/jwks.json",
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
  reason: "CLERK_JWT_ISSUER, CLERK_JWKS_URL, and CLAXEDO_WORKSPACE_AUTHORITY_URL are required for signed/cloud auth",
}

describe("provider-auth gate (signed mode)", () => {
  // Higher stakes than a plain read route: the OAuth callback calls
  // deleteCredentialsByProvider + putCredential, so an unauthenticated caller
  // could replace a box's provider credentials with their own.
  const credentialsStub = { credentials: {} } as never

  function mountProvider(config: ControlPlaneAuthConfig) {
    const app = new Hono()
    app.route("/", ProviderAuthRoutes(credentialsStub, { authConfig: config }))
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
    // that sent nothing is told the token is MISSING, one that sent something
    // unverifiable is told it is INVALID. The unsigned-local block below exists
    // because this router used to answer `missing_bearer_token` to a request
    // that plainly carried a bearer.
    const app = mountProvider(signedConfig)
    const missing = await app.request("/provider/auth")
    expect(await missing.json()).toMatchObject({ error: { code: "missing_bearer_token" } })
    const invalid = await app.request("/provider/auth", { headers: { authorization: "Bearer nope" } })
    expect(await invalid.json()).toMatchObject({ error: { code: "invalid_bearer_token" } })
  })
})

// In unsigned-local (`CLAXEDO_SIGNED_CLOUD_AUTH` unset) this gate cannot
// evaluate a bearer at all: `controlPlaneAuthContext` short-circuits on
// `!config.enabled` and returns `unsigned-local`, so no token can ever produce
// `mode === "signed"`. The gate used to skip its pass-through the moment ANY
// Authorization header was present and then fall into that unsatisfiable
// branch, so a request WITH a bearer got 401 `missing_bearer_token` while the
// same request WITHOUT one was served. That is not a gate — the caller just
// drops the header and walks in — and the code it reported was untrue.
//
// The real gate in this posture is the global `unsignedLocalRequestGuard`
// (loopback-only, 403 `unsigned_local_loopback_required` off-box). So the
// bearer is ignored here, matching `network-policy.ts`'s `routeAuth`, which
// already resolves the same case to an anonymous pass. Two postures must NOT
// change: `misconfigured` still fails closed with 503, and signed mode still
// requires a verified identity (above).
describe("provider-auth gate (unsigned local)", () => {
  const credentialsStub = { credentials: {} } as never

  function mountProvider(config: ControlPlaneAuthConfig) {
    const app = new Hono()
    app.route("/", ProviderAuthRoutes(credentialsStub, { authConfig: config }))
    return app
  }

  test("an anonymous request is served", async () => {
    const res = await mountProvider(unsignedLocalConfig).request("http://localhost:3001/provider/auth")
    expect(res.status).toBe(200)
  })

  test.each([
    ["the app's synthetic e2e token", "test-bypass-token"],
    ["a stale Clerk session token", "eyJhbGciOiJSUzI1NiJ9.stale.signature"],
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
