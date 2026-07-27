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
type ControlPlaneAuthConfig = import("../control-plane/auth").ControlPlaneAuthConfig

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
// been removed from the tree, so `provider-auth` is what remains to hold. The
// structural guard against a *future* ungated mount lives in
// architecture.test.ts — this file covers the runtime behaviour.

const signedConfig: ControlPlaneAuthConfig = {
  enabled: true,
  issuer: "https://example.clerk.dev",
  jwksUrl: "https://example.clerk.dev/.well-known/jwks.json",
  audience: "claxedo-server",
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
})
