import { describe, expect, test } from "vitest"
import { Hono } from "hono"

const { ProviderAuthRoutes } = await import("./provider-auth")
type ControlPlaneAuthConfig = import("../authority/auth").ControlPlaneAuthConfig

// `deferToHarnessRoute` makes `/provider/auth` call `next()` so a LATER-mounted
// OpenCode-compat route answers instead. That fall-through is the one shape
// where the auth gate could plausibly be bypassed: if the gate were attached to
// the handler rather than to the path, a deferred request would leave this
// router — and land on a compat route that has no gate of its own — while never
// having been authenticated.
//
// It is safe because `.use("/provider/*", controlPlaneRouteAuth(options))` is
// registered before the routes, so it runs for the REQUEST, not for a
// particular handler; `next()` continues past an already-executed gate. These
// tests pin that, because the safety is a property of middleware ordering that
// a future refactor could silently undo.

const signedConfig: ControlPlaneAuthConfig = {
  enabled: true,
  issuer: "https://example.clerk.dev",
  jwksUrl: "https://example.clerk.dev/.well-known/jwks.json",
  audience: "claxedo-server",
}

const credentialsStub = { credentials: {} } as never

/** Mirrors server.ts: provider-auth mounted first, compat route after it. */
function mountWithCompatFallthrough(config: ControlPlaneAuthConfig, defer: boolean) {
  const app = new Hono()
  app.route(
    "/",
    ProviderAuthRoutes(credentialsStub, {
      authConfig: config,
      deferToHarnessRoute: () => defer,
    }),
  )
  // Stands in for OpenCodeCompatRoutes' `/provider/auth`, which carries no gate
  // of its own — it is reachable only through the deferral above.
  app.get("/provider/auth", (c) => c.json({ reachedCompatRoute: true }))
  return app
}

describe("provider-auth deferral cannot outrun the auth gate", () => {
  test("an unauthenticated request that WOULD defer is still refused", async () => {
    const res = await mountWithCompatFallthrough(signedConfig, true).request("/provider/auth?harness=opencode")
    expect(res.status).toBe(401)
    // The precise failure this guards against: a 200 here would mean the
    // request skipped the gate and was answered by the ungated compat route.
    expect(await res.text()).not.toContain("reachedCompatRoute")
  })

  test("an unauthenticated request that would NOT defer is refused the same way", async () => {
    const res = await mountWithCompatFallthrough(signedConfig, false).request("/provider/auth?harness=codex")
    expect(res.status).toBe(401)
  })

  test("the deferral still works when the gate is not engaged", async () => {
    // Control: proves the 401s above come from the gate rather than from the
    // deferral being broken — with auth disabled the compat route does answer.
    const unsigned = { enabled: false, mode: "local-only" } as unknown as ControlPlaneAuthConfig
    const res = await mountWithCompatFallthrough(unsigned, true).request("/provider/auth?harness=opencode")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ reachedCompatRoute: true })
  })
})
