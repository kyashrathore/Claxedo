/**
 * Every route the hosted app mounts either REFUSES an
 * anonymous remote caller, or is a named entry below explaining what it serves
 * one instead.
 *
 * Why this guard exists. The audit behind this wave found ~20 distinct guard
 * combinations across 49 route files, assembled from ten primitives
 * (`controlPlaneAuthContext`, `bearerToken`, `isLoopbackLocalRequest`,
 * `routeAuth`'s `requireSigned` flag, ...). Nothing recorded which combination
 * a route MEANT, so "is this route authenticated?" could only be answered by
 * reading it — and a security change had a dozen landing sites with no way to
 * know you had found them all. This test is the missing record.
 *
 * The check is behavioral, not textual. Asserting that a file imports a guard
 * proves the import, not the protection: a guard can be imported and never
 * mounted, mounted on the wrong prefix, or shadowed by a route registered
 * earlier. So this drives a real anonymous non-loopback request through the
 * composed app and looks at what comes back.
 *
 * On the ANONYMOUS_OK list below. Auditing every entry there found no data
 * exposure: each returns a constant, an empty collection, or an echo of the
 * caller's own query string, and the ones that CAN return real data
 * (`/project`, `/provider`) authenticate first and answer empty without a
 * bearer. They are listed rather than "fixed" because their 200 is a deliberate
 * contract with the SPA shell, and because a guard that fails on safe routes
 * gets suppressed rather than read. What the list buys is that the set is now
 * FIXED: a new route that serves anonymous callers is not on it, and fails.
 *
 * Both directions are load-bearing, matching `route-guard-inventory.test.ts`:
 *   1. A mounted route serving an anonymous caller and NOT named below fails.
 *   2. A STALE entry — one matching no mounted route — also fails, so renaming
 *      a route cannot leave a permanent silent exemption behind it.
 */

import { describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { createHostedApp } from "../../deployments/hosted-shared/hosted-app"
import { sandboxRelayTargetLookup, type HostedControlPlane } from "../../authority/hosted-services"
import type { ControlPlaneServices } from "../../authority/services"
import { durableCliSessionTokenRegistry } from "../../test-support/cli-session-registry"

/**
 * Routes that answer an unauthenticated caller with a non-refusal, and why that
 * is safe. Every entry was verified by reading the handler: the claim in
 * `serves` is what the code returns to a caller with no credential.
 */
const ANONYMOUS_OK: ReadonlyArray<{ path: string; serves: string }> = [
  // --- Liveness / capability advertisement: constants, no per-tenant state.
  { path: "/api/claxedo/health", serves: "A liveness constant plus the deployment mode." },
  { path: "/global/health", serves: "Liveness for load balancers, which cannot present a credential." },
  { path: "/api/claxedo/mode", serves: "Which capabilities this deployment composed; no tenant data." },
  { path: "/api/claxedo/compatibility", serves: "Protocol version numbers the client needs pre-auth to negotiate." },
  {
    path: "/api/claxedo/services",
    serves: "{ authenticated: false, services: [] }; the catalog itself requires signed auth.",
  },

  // --- SPA shell mirrors: echo the caller's own query, or a constant shape.
  { path: "/path", serves: "Echoes the caller's own ?directory back in the opencode path shape." },
  { path: "/project/current", serves: "Echoes the caller's own ?directory back in the opencode project shape." },
  { path: "/provider/auth", serves: "An empty object unless ?harness=pi, which returns a static catalog shape." },

  // --- Authenticate first, then answer empty rather than 401.
  { path: "/project", serves: "signedProjects() returns [] without a bearer; real projects require signed auth." },
  { path: "/provider", serves: "emptyProvider() unless ?harness=pi, which requires signed auth to list anything." },
  { path: "/api/workspace", serves: "{workspaces: []} unless ?access=cloud|user-hosted, which requires signed auth." },
  { path: "/api/workspace/resolve", serves: "The literal null the app reads as 'no central runtime snapshot'." },
  { path: "/api/control/sessions", serves: "{sessions: []} without ?workspaceId; the data path requires signed auth." },
  {
    path: "/api/control/sessions/:id/messages",
    serves: "400 WORKSPACE_ID_REQUIRED before auth; the data path requires signed auth.",
  },
  {
    path: "/api/claxedo/agent-config/extensions",
    serves: "The empty desired/materialized extension state for a plane with no catalog configured.",
  },
  {
    path: "/api/claxedo/agent-config/extensions/catalog",
    serves: "The empty extension catalog for a plane with no catalog configured.",
  },
  {
    path: "/api/claxedo/agent-config/extensions/machine-scan",
    serves: "The empty machine-scan result; the hosted plane has no machine to scan.",
  },

  // --- Signature- or config-gated rather than bearer-gated.
  {
    path: "/api/billing/polar/webhook",
    serves: "Authenticated by Svix signature over the raw body; the signature check is the gate.",
  },
  { path: "/api/auth/device/code", serves: "501 device_login_unconfigured until device login is configured." },
  { path: "/api/auth/device/token", serves: "501 device_login_unconfigured until device login is configured." },
  { path: "/.well-known/jwks.json", serves: "Public keys; publishing them is the endpoint's entire function." },

  // --- Validated before authenticated.
  {
    path: "/documents",
    serves: "400 document_invalid_body on schema validation; a well-formed body then requires signed auth.",
  },
  {
    path: "/api/claxedo/integrations",
    serves: "Fails without a configured connections backend; the data path requires signed auth.",
  },
  {
    path: "/api/claxedo/integrations/probe",
    serves: "Fails without a configured connections backend; the data path requires signed auth.",
  },
]

/**
 * Probe paths substitute a placeholder per `:param`, so entries are normalised
 * the same way before comparison.
 */
function normalise(path: string) {
  return path.replace(/:[^/]+/g, "posture-inventory-probe")
}

const ANONYMOUS_OK_PATHS = new Set(ANONYMOUS_OK.map((entry) => normalise(entry.path)))

function inventoryPlane(): HostedControlPlane {
  const services = {
    auth: {
      config: { enabled: true, issuer: "https://clerk.test", jwksUrl: "https://clerk.test/jwks" },
      verifier: vi.fn(async () => {
        throw new Error("an anonymous probe must never reach the verifier")
      }),
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

/** See `route-guard-inventory.test.ts` — patterns become requestable paths. */
function mountedRoutePaths(app: Hono) {
  const paths = new Set<string>()
  for (const route of app.routes) {
    if (route.path === "/*" || route.path === "*") continue
    paths.add(normalise(route.path).replace(/\/\*$/, "/probe"))
  }
  return [...paths].toSorted()
}

/**
 * Every (method, path) pair the app actually serves.
 *
 * Probing a fixed GET/POST pair is not enough: a DELETE-only route answers 404
 * to GET, `isRefusal(404)` is true, and the guard scores a refusal for a
 * handler it never reached. Four paths in the hosted app are outside that pair
 * today (`/auth/:providerID` PUT+DELETE, `/documents/:id/runtime-job` DELETE,
 * `/documents/:id/runtime-writeback` PUT, `/documents/:id/session` PATCH), so
 * an unguarded handler on any of them was invisible.
 */
function mountedRouteMethods(app: Hono) {
  const pairs = new Map<string, Set<string>>()
  for (const route of app.routes) {
    if (route.path === "/*" || route.path === "*") continue
    const method = route.method.toUpperCase()
    // `ALL` registers every verb; probe the ones a caller would reach for.
    const methods = method === "ALL" ? ["GET", "POST", "PUT", "PATCH", "DELETE"] : [method]
    const path = normalise(route.path).replace(/\/\*$/, "/probe")
    const set = pairs.get(path) ?? new Set<string>()
    for (const m of methods) set.add(m)
    pairs.set(path, set)
  }
  return [...pairs.entries()]
    .map(([path, methods]) => ({ path, methods: [...methods].toSorted() }))
    .toSorted((a, b) => a.path.localeCompare(b.path))
}

/**
 * A refusal is any non-2xx. The property under test is that an anonymous remote
 * caller does not get SERVICE — not that every route picked the same status, and
 * not that it refused for an auth reason specifically.
 *
 * 4xx-that-is-not-401 counts on purpose. A route that rejects the request shape
 * (400 invalid body, 428 missing If-Match) has served the caller nothing, and
 * several documents routes validate before they authenticate. Demanding a 401
 * there would be asserting handler ORDER, not reachability, and the honest
 * summary of such a route is "unreachable without a valid body AND a bearer".
 * 5xx counts for the same reason: a dependency the anonymous caller never got
 * past is still not service.
 */
function isRefusal(status: number) {
  return status < 200 || status >= 300
}

/**
 * A body that satisfies the union of the schemas the POST surfaces validate.
 *
 * This matters more than it looks. Several routes (`documents/*`) validate the
 * body BEFORE authenticating, so an empty `{}` probe returns 400 for a schema
 * reason and never reaches the auth check — the probe would then be asserting
 * that Zod rejects `{}`, which is true of a completely unguarded route too.
 * Sending a plausibly-valid body pushes the probe past validation so the
 * refusal it observes is the AUTH refusal.
 */
const PROBE_BODY = JSON.stringify({
  status: "draft",
  path: "probe.md",
  markdown: "",
  display_name: "probe",
  workspace_id: "probe",
  session_id: "probe",
  repository_url: "https://example.test/probe.git",
})

/**
 * `cp.test` is not a loopback host, so `isLoopbackLocalRequest` is false and
 * every loopback-gated route must refuse — the remote-attacker case.
 */
async function anonymousStatus(app: Hono, path: string, method: string) {
  const response = await app.fetch(
    new Request(`https://cp.test${path}`, {
      method,
      ...(method === "GET"
        ? {}
        : { headers: { "content-type": "application/json" }, body: PROBE_BODY }),
    }),
  )
  return response.status
}

async function refusesAnonymous(app: Hono, path: string, method: string) {
  // 405 means the probe used a method this path does not serve, so it never
  // reached a handler and proves nothing either way.
  return isRefusal(await anonymousStatus(app, path, method))
}

describe("Route posture inventory", () => {
  test("the hosted app mounts a non-trivial route table (the inventory is not vacuous)", () => {
    // A guard that silently enumerates zero routes passes forever.
    const paths = mountedRoutePaths(createHostedApp(inventoryPlane()))
    expect(paths.length).toBeGreaterThan(20)
    expect(paths.some((path) => path.startsWith("/api/workspace"))).toBe(true)
    expect(paths.some((path) => path.startsWith("/documents"))).toBe(true)
  })

  test("every mounted route refuses an anonymous remote caller, unless it is a named ANONYMOUS_OK route", async () => {
    const app = createHostedApp(inventoryPlane())
    const served: string[] = []

    for (const { path, methods } of mountedRouteMethods(app)) {
      if (ANONYMOUS_OK_PATHS.has(path)) continue
      for (const method of methods) {
        if (!(await refusesAnonymous(app, path, method))) {
          served.push(`${method} ${path} -> ${await anonymousStatus(app, path, method)}`)
        }
      }
    }

    // Any entry here is a route serving an unauthenticated internet caller that
    // nobody has audited. Read the handler, then either fix it or add it to
    // ANONYMOUS_OK with what it actually returns.
    expect(served).toEqual([])
  })

  test("POSITIVE CONTROL: a route mounted with no posture is caught", async () => {
    // Proof the inventory has teeth — the exact mistake it exists to catch.
    const unguarded = new Hono()
    unguarded.get("/api/brand-new-surface", (c) => c.json({ ok: true }))

    expect(await refusesAnonymous(unguarded, "/api/brand-new-surface", "GET")).toBe(false)
  })

  test("every ANONYMOUS_OK entry states what it serves an unauthenticated caller", () => {
    for (const entry of ANONYMOUS_OK) {
      // An entry without this is indistinguishable from a route someone forgot
      // to protect and then silenced.
      expect(entry.serves.length, `${entry.path} needs a 'serves' description`).toBeGreaterThan(30)
    }
  })

  test("no ANONYMOUS_OK entry is STALE — each matches a route the app actually mounts", () => {
    const paths = new Set(mountedRoutePaths(createHostedApp(inventoryPlane())))
    const stale = ANONYMOUS_OK.filter((entry) => !paths.has(normalise(entry.path))).map(
      (entry) => entry.path,
    )

    // A renamed route would otherwise leave its exemption matching nothing while
    // the new path is never checked by the loop above.
    expect(stale).toEqual([])
  })
})
