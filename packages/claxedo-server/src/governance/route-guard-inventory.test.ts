/**
 * W3 acceptance: EVERY mounted hosted route inherits a body cap unless it is
 * explicitly, namedly exempted — and this test fails when a new route skips both.
 *
 * Why an inventory test and not review: the pre-W3 posture was opt-in and the
 * result was ~50 routes with no limiter and no cap, including the WorkGraph
 * surface, the documents surface, and checkpoint/lifecycle destroy. Every one of
 * those was a review that did not happen. The failure mode of a forgotten cap is
 * silence, so the guard has to be executable.
 *
 * Two directions, both load-bearing:
 *   1. A mounted route with neither the default guard nor an exemption FAILS.
 *      Proven by the positive control below, which mounts a deliberately
 *      unprotected route and asserts the inventory rejects it.
 *   2. A STALE exemption — one matching no mounted route — also fails. Without
 *      this, renaming `/documents` to `/docs` would leave a permanent silent
 *      hole: the exemption keeps matching nothing, and the new path quietly
 *      takes the default it may not be able to satisfy.
 *
 * Modeled on `worker-cron-drift.test.ts`.
 */

import { describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { createHostedApp } from "../deployments/hosted-shared/hosted-app"
import { sandboxRelayTargetLookup, type HostedControlPlane } from "../authority/hosted-services"
import type { ControlPlaneServices } from "../authority/services"
import { durableCliSessionTokenRegistry } from "../test-helpers/cli-session-registry"
import {
  DEFAULT_MAX_BODY_BYTES,
  defaultRequestGuard,
  guardExemptionFor,
  hostedRouteGuardExemptions,
  pathMatchesPrefix,
} from "../authority/request-guard"
import { BILLING_WEBHOOK_GUARD_EXEMPTION } from "../billing/routes"

/**
 * The exemption set the hosted app actually composes: the core list plus every
 * feature-contributed entry. The test must assert against the COMPOSITION, not
 * the core constant — a feature exemption that hosted-app.ts forgot to merge
 * would otherwise look exempt here while the running app applied the default.
 */
const EXEMPTIONS = hostedRouteGuardExemptions([BILLING_WEBHOOK_GUARD_EXEMPTION])

/**
 * The smallest plane that composes a hosted app. This test only needs the ROUTE
 * TABLE and the guard's response to an oversized body, so authority/relay
 * behavior is irrelevant — every route may 401/503 and the inventory still holds.
 */
function inventoryPlane(): HostedControlPlane {
  const services = {
    auth: {
      config: { enabled: true, issuer: "https://clerk.test", jwksUrl: "https://clerk.test/jwks" },
      verifier: vi.fn(async () => ({ mode: "signed", user: { subject: "u", tokenIdentifier: "t", issuer: "i" } })),
    },
    relay: { relayUrl: "https://relay.test", resolverToken: "resolver-token" },
    sandbox: {},
    authority: {
      resolveOrgId: vi.fn(async () => "org_1"),
      usersMe: vi.fn(async () => ({ id: "u", user_id: "u" })),
      listWorkspaces: vi.fn(async () => []),
      auditAllow: vi.fn(async () => ({})),
    },
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: false },
  } as unknown as ControlPlaneServices

  return {
    services,
    relayUrl: "https://relay.test",
    resolverToken: "resolver-token",
    safetyLimits: {
      connectionRateLimit: 6,
      connectionRateLimitWindowMs: 60_000,
      controlPlaneRateLimit: 120,
      controlPlaneRateLimitWindowMs: 60_000,
      defaultRequestRateLimit: 10_000,
      defaultRequestRateLimitWindowMs: 60_000,
      sandboxMaxRetryCount: 5,
    },
    relayTargetLookup: sandboxRelayTargetLookup({ telemetry: services.telemetry }),
    cliSessionTokenRegistry: durableCliSessionTokenRegistry().registry,
    env: {
      CLAXEDO_DEPLOYMENT_MODE: "hosted",
      CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
      CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
    },
  } as unknown as HostedControlPlane
}

/**
 * Every route the hosted app mounts, as concrete request paths.
 *
 * Hono's `routes` table holds patterns (`/api/workspace/:id/connection`) and
 * middleware entries (`/*`). Patterns are turned into requestable paths by
 * substituting a placeholder per `:param`, because the guard is a middleware
 * keyed on the REQUEST path — asserting against a pattern string would test the
 * table rather than the behavior.
 */
function mountedRoutePaths(app: Hono) {
  const paths = new Set<string>()
  for (const route of app.routes) {
    // `/*` and `*` are the middleware registrations themselves (securityHeaders,
    // CORS, the unsigned-local gate, and the guard under test).
    if (route.path === "/*" || route.path === "*") continue
    paths.add(route.path.replace(/:[^/]+/g, "guard-inventory-probe").replace(/\/\*$/, "/probe"))
  }
  return [...paths].toSorted()
}

/** A body one byte over the default cap. */
function oversizedBody() {
  return "x".repeat(DEFAULT_MAX_BODY_BYTES + 1)
}

/**
 * Does this path reject an oversized body? Sent as POST regardless of the route's
 * real method: Hono runs app-level middleware BEFORE routing, so the cap answers
 * 413 even where the method would otherwise 404. That is the property under test
 * — the guard is not reachable-only-through-a-matching-route.
 */
async function capsOversizedBody(app: Hono, path: string) {
  const response = await app.fetch(
    new Request(`http://cp.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(DEFAULT_MAX_BODY_BYTES + 1) },
      body: oversizedBody(),
    }),
  )
  return response.status === 413
}

describe("W3.2 hosted route guard inventory", () => {
  test("the hosted app mounts a non-trivial route table (the inventory is not vacuous)", () => {
    // A guard test that silently enumerates zero routes passes forever. This is
    // the floor assertion that makes the rest meaningful.
    const paths = mountedRoutePaths(createHostedApp(inventoryPlane()))
    expect(paths.length).toBeGreaterThan(20)
    // Spot-check the surfaces the review named as unprotected.
    expect(paths.some((path) => path.startsWith("/api/workgraph"))).toBe(true)
    expect(paths.some((path) => path.startsWith("/documents"))).toBe(true)
    expect(paths.some((path) => path.startsWith("/api/workspace"))).toBe(true)
  })

  test("every mounted route either caps an oversized body or is a named exemption", async () => {
    const app = createHostedApp(inventoryPlane())
    const unprotected: string[] = []

    for (const path of mountedRoutePaths(app)) {
      if (guardExemptionFor(path, "bodyCap", EXEMPTIONS)) continue
      if (!(await capsOversizedBody(app, path))) unprotected.push(path)
    }

    // Any entry here is a route that will buffer an arbitrarily large body.
    expect(unprotected).toEqual([])
  })

  test("POSITIVE CONTROL: a route mounted with no cap and no exemption is caught", async () => {
    // Proof the inventory has teeth. This mounts the exact mistake the test
    // exists to catch — a new route added to an app WITHOUT the default guard —
    // and asserts the check reports it rather than passing.
    const unguarded = new Hono()
    unguarded.post("/api/brand-new-surface", (c) => c.json({ ok: true }))

    expect(await capsOversizedBody(unguarded, "/api/brand-new-surface")).toBe(false)

    // And the same route behind the default guard IS capped — so the difference
    // is the guard, not the probe.
    const guarded = new Hono()
    guarded.use(defaultRequestGuard())
    guarded.post("/api/brand-new-surface", (c) => c.json({ ok: true }))

    expect(await capsOversizedBody(guarded, "/api/brand-new-surface")).toBe(true)
  })

  test("no exemption is STALE — each one matches a route the app actually mounts", () => {
    const paths = mountedRoutePaths(createHostedApp(inventoryPlane()))
    const stale = EXEMPTIONS.filter(
      (entry) => !paths.some((path) => pathMatchesPrefix(path, entry.prefix)),
    ).map((entry) => entry.prefix)

    // A renamed route would leave its exemption matching nothing while the new
    // path silently takes a default it may not be able to satisfy.
    expect(stale).toEqual([])
  })

  test("every exemption states a reason and where the replacement protection lives", () => {
    for (const entry of EXEMPTIONS) {
      // An exemption without these is indistinguishable from a route someone
      // forgot; the registry only helps if each entry is auditable.
      expect(entry.reason.length, `exemption ${entry.prefix} needs a reason`).toBeGreaterThan(40)
      expect(entry.enforcedBy.length, `exemption ${entry.prefix} needs enforcedBy`).toBeGreaterThan(10)
      expect(entry.bodyCap === true || entry.rateLimit === true, `exemption ${entry.prefix} exempts nothing`).toBe(true)
    }
  })

  test("documents keeps its own 2 MiB cap rather than the 1 MiB default", async () => {
    // The strangler requirement: the documents surface had a working, reviewed
    // cap before W3 and must be unchanged by it. A body between the two limits
    // proves the default is NOT being applied there.
    const app = createHostedApp(inventoryPlane())
    expect(guardExemptionFor("/documents", "bodyCap", EXEMPTIONS)).toBeDefined()
    expect(guardExemptionFor("/documents/doc_1/versions", "bodyCap", EXEMPTIONS)).toBeDefined()

    const between = "x".repeat(DEFAULT_MAX_BODY_BYTES + 1024)
    const response = await app.fetch(
      new Request("http://cp.test/documents", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer u" },
        body: JSON.stringify({ display_name: "doc", markdown: between }),
      }),
    )
    // Whatever documents answers (401/503/400 in this bare plane), it must not be
    // the DEFAULT guard's 413 — that would mean W3 tightened a reviewed surface.
    expect(response.status).not.toBe(413)
  })
})

describe("W3.3 the webhook exemption is live in the composed app", () => {
  test("a webhook body over the webhook's OWN cap is rejected by the webhook, not the default guard", async () => {
    // The exemption's purpose: the route's tighter 512 KiB cap governs. This
    // asserts the composed app actually honors it — a body between the two caps
    // must reach the route (which then answers on its own terms) rather than
    // being 413'd by the app-wide 1 MiB guard.
    const app = createHostedApp(inventoryPlane())
    const response = await app.fetch(
      new Request("http://cp.test/api/billing/polar/webhook", {
        method: "POST",
        body: "x".repeat(700 * 1024),
        headers: { "cf-connecting-ip": "198.51.100.9" },
      }),
    )

    // 413 from the WEBHOOK's cap (512 KiB), reported with the webhook's own code
    // — proof the route ran and the default guard did not preempt it.
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ error: { code: "billing_webhook_body_too_large" } })
  })

  test("a normal-sized webhook delivery passes the app-level guard and reaches the route", async () => {
    const app = createHostedApp(inventoryPlane())
    const response = await app.fetch(
      new Request("http://cp.test/api/billing/polar/webhook", {
        method: "POST",
        body: JSON.stringify({ type: "customer.state_changed" }),
        headers: { "cf-connecting-ip": "198.51.100.9" },
      }),
    )

    // No webhook secret in this bare plane, so the route fails closed with 503 —
    // the point is that it is the ROUTE's answer, not a 413 or 429.
    expect([401, 503]).toContain(response.status)
  })
})

describe("W3 acceptance: two hosted app instances share one global limit", () => {
  /**
   * The plan's acceptance criterion, exercised through the REAL composed app
   * rather than the limiter in isolation.
   *
   * Two `createHostedApp` instances are two isolates in the only sense that
   * matters here: each builds its own `createFixedWindowConnectionRateLimiter`
   * and therefore its own bucket `Map`, exactly as two Cloudflare isolates do.
   * Both receive the SAME `sharedRateLimitStore`, which is what a
   * `[[ratelimits]]` binding is across isolates.
   */
  function sharedStore(limit: number) {
    const counts = new Map<string, number>()
    return {
      periodSeconds: 60,
      async check(key: string) {
        const next = (counts.get(key) ?? 0) + 1
        counts.set(key, next)
        return { allowed: next <= limit }
      },
    }
  }

  function twoIsolates(input: { limit: number; store?: ReturnType<typeof sharedStore> }) {
    const plane = () => {
      const base = inventoryPlane()
      // Local fuse LOOSER than the global limit, so a passing test cannot be
      // explained by the per-isolate fuse having done the work.
      base.safetyLimits = { ...base.safetyLimits, defaultRequestRateLimit: 10_000 }
      return base
    }
    return [
      createHostedApp(plane(), input.store ? { sharedRateLimitStore: input.store } : {}),
      createHostedApp(plane(), input.store ? { sharedRateLimitStore: input.store } : {}),
    ]
  }

  /** Round-robin health checks across both isolates from one client IP. */
  async function driveHealth(apps: Hono[], total: number) {
    let allowed = 0
    let limited = 0
    for (let i = 0; i < total; i += 1) {
      const response = await apps[i % apps.length]!.fetch(
        new Request("http://cp.test/api/claxedo/health", { headers: { "cf-connecting-ip": "198.51.100.9" } }),
      )
      if (response.status === 429) limited += 1
      else allowed += 1
    }
    return { allowed, limited }
  }

  test("the GLOBAL limit is enforced across both isolates, not 2x", async () => {
    const GLOBAL_LIMIT = 10
    const shared = await driveHealth(twoIsolates({ limit: GLOBAL_LIMIT, store: sharedStore(GLOBAL_LIMIT) }), 60)

    expect(shared.allowed).toBe(GLOBAL_LIMIT)
    expect(shared.limited).toBe(50)
  })

  test("POSITIVE CONTROL: with the shared store disabled the same drive leaks 2x", async () => {
    // Pre-W3 behavior through the real app. Each isolate's fuse is set to the
    // intended global limit, and the pair admits twice it — the finding exactly.
    const GLOBAL_LIMIT = 10
    const plane = () => {
      const base = inventoryPlane()
      base.safetyLimits = { ...base.safetyLimits, defaultRequestRateLimit: GLOBAL_LIMIT }
      return base
    }
    const leaked = await driveHealth([createHostedApp(plane()), createHostedApp(plane())], 60)

    expect(leaked.allowed).toBe(GLOBAL_LIMIT * 2)
    expect(leaked.allowed).toBeGreaterThan(GLOBAL_LIMIT)
  })

  test("a 429 from the shared store carries Retry-After", async () => {
    const [app] = twoIsolates({ limit: 1, store: sharedStore(1) })
    const send = () =>
      app!.fetch(new Request("http://cp.test/api/claxedo/health", { headers: { "cf-connecting-ip": "198.51.100.9" } }))

    expect((await send()).status).toBe(200)
    const rejected = await send()
    expect(rejected.status).toBe(429)
    expect(Number(rejected.headers.get("retry-after"))).toBe(60)
  })
})

describe("W3.2 exemption matching", () => {
  test("prefixes match on segment boundaries, so one exemption cannot widen to a sibling", () => {
    expect(pathMatchesPrefix("/documents", "/documents")).toBe(true)
    expect(pathMatchesPrefix("/documents/doc_1", "/documents")).toBe(true)
    // The hazard: a naive startsWith would exempt an unrelated admin surface.
    expect(pathMatchesPrefix("/documents-admin", "/documents")).toBe(false)
    expect(pathMatchesPrefix("/documentsomething", "/documents")).toBe(false)
  })

  test("an exemption only covers the guard it names", () => {
    // /documents is exempt from the body cap ONLY; it must still take the
    // default rate limit, or exempting a cap would silently exempt abuse limiting.
    expect(guardExemptionFor("/documents", "bodyCap", EXEMPTIONS)).toBeDefined()
    expect(guardExemptionFor("/documents", "rateLimit", EXEMPTIONS)).toBeUndefined()

    // The webhook is exempt from both, and says so.
    expect(guardExemptionFor("/api/billing/polar/webhook", "bodyCap", EXEMPTIONS)).toBeDefined()
    expect(guardExemptionFor("/api/billing/polar/webhook", "rateLimit", EXEMPTIONS)).toBeDefined()
  })

  test("a route with no exemption is covered by both guards", () => {
    expect(guardExemptionFor("/api/workgraph/commands", "bodyCap", EXEMPTIONS)).toBeUndefined()
    expect(guardExemptionFor("/api/workgraph/commands", "rateLimit", EXEMPTIONS)).toBeUndefined()
  })

  test("the composition adds feature exemptions without dropping the core ones", () => {
    // The split registry's failure mode: a feature exemption declared but never
    // merged (or a merge that replaces rather than appends). Both would be
    // invisible without asserting the composed list contains both sources.
    const prefixes = EXEMPTIONS.map((entry) => entry.prefix)
    expect(prefixes).toContain("/documents")
    expect(prefixes).toContain("/api/billing/polar/webhook")
    expect(prefixes).toContain("/api/claxedo/events")

    // And with no features passed, the core list stands alone — so the billing
    // entry above is provably arriving via composition, not hiding in the core.
    expect(hostedRouteGuardExemptions().map((entry) => entry.prefix)).not.toContain("/api/billing/polar/webhook")
  })
})
