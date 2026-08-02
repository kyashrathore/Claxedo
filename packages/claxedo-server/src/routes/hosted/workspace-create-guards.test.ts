import { beforeEach, describe, expect, test, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { ClerkVerifier } from "../../authority/auth"
import type { ControlPlaneServices } from "../../authority/services"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import { createFixedWindowConnectionRateLimiter } from "../../authority/rate-limit"
import { HostedWorkspaceRoutes, type HostedWorkspaceRouteOptions } from "./workspace"
import { countActiveForOrg } from "../../../../../convex/sandboxLeases"
import { indexRangeBuilder } from "../../test-helpers/convex-index-harness"

/**
 * The create path stamps the lease's tenant through this, fire-and-forget,
 * after `ensure` resolves. Stubbing it is what lets the tests below assert WHAT
 * gets attributed — and it also keeps the real one, which resolves a Convex url
 * and service token from `process.env` at call time, out of a route test.
 */
const recordSandboxLeaseTenant = vi.hoisted(() =>
  vi.fn(
    async (_input: {
      workspace_id: string
      owner_subject: string
      metering?: { org_id: string; user_id: string }
    }) => ({ stamped: true }),
  ),
)
vi.mock("../../telemetry/convex-usage-ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../telemetry/convex-usage-ledger")>()),
  recordSandboxLeaseTenant,
}))

beforeEach(() => {
  recordSandboxLeaseTenant.mockClear()
})

/**
 * The stamping call hangs off `void sandboxManager.ensure(...).then(...)`, which
 * deliberately does not block the create response — so a test that asserts on it
 * has to let the fire-and-forget tail settle first.
 */
async function settleLeaseAttribution() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * A counter whose parameter is typed, so a test can assert on the SCOPE it was
 * handed — which is the whole subject of this file's cap tests.
 */
function leaseCounter(active: number | undefined) {
  return vi.fn(async (_scope: { orgId?: string; ownerSubject?: string }) => active)
}

/**
 * Security review 2026-07-27 §4.3 — `POST /create` was the ONLY mutating route
 * in `workspace.ts` with no rate limiter, and it is the only one that
 * provisions real infrastructure (`sandboxManager.ensure`). There was also no
 * per-org cap on concurrently-live sandboxes anywhere in the repo, so an
 * attacker (or a runaway client) could accumulate provisioned VMs at real cost.
 *
 * Two independent defences, because neither subsumes the other:
 *
 *   - the RATE LIMITER bounds requests per minute, but it is a per-isolate
 *     in-memory Map (§6.7), so its ceiling does not hold across Cloudflare
 *     isolates and it says nothing about how many sandboxes are already live;
 *   - the LEASE CAP bounds total live sandboxes against durable Convex state,
 *     so it holds across isolates and also catches a slow drip that never
 *     trips a rate limit.
 *
 * Plus a structural ratchet (same philosophy as `convex-authz-guard.test.ts`)
 * so a future mutating route cannot silently skip the limiter again.
 */

const authConfig = {
  enabled: true,
  issuer: "https://clerk.example.test",
  jwksUrl: "https://clerk.example.test/.well-known/jwks.json",
} as const

/**
 * Tokens carry a Clerk org claim unless the subject is prefixed `noorg_`, which
 * models a personal-account sign-in (no `org_id` claim). The whole tenancy of
 * the lease cap hangs on that claim, so it has to be expressible here.
 */
const verifier: ClerkVerifier = async (token, config) => ({
  mode: "signed" as const,
  user: {
    subject: token,
    tokenIdentifier: `${config.issuer}|${token}`,
    issuer: config.issuer,
    ...(token.startsWith("noorg_") ? {} : { orgId: `org_of_${token}` }),
  },
})

function fakeAuthority(overrides: Record<string, unknown> = {}) {
  return {
    usersMe: vi.fn(async () => ({ subject: "user_1" })),
    // The authority's OWN org id space (Convex document ids). The cap must not
    // use this — lease rows are stamped with the Clerk claim.
    resolveOrgId: vi.fn(async () => "convex_org_doc_id"),
    createCloudWorkspace: vi.fn(async () => ({ workspace_id: "ignored" })),
    pauseLocalHostLink: vi.fn(async () => ({ paused: true, count: 1 })),
    auditAllow: vi.fn(async () => ({})),
    auditDeny: vi.fn(async () => ({})),
    ...overrides,
  }
}

function buildApp(opts: {
  authority?: ReturnType<typeof fakeAuthority>
  options?: Partial<HostedWorkspaceRouteOptions>
  ensure?: ReturnType<typeof vi.fn>
} = {}) {
  const authority = opts.authority ?? fakeAuthority()
  const ensure = opts.ensure ?? vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
  const services = {
    authority,
    sandbox: { sandboxManager: { ensure } as unknown as SandboxManager, defaultDriver: "fetch" },
    telemetry: { capture: vi.fn() },
  } as unknown as ControlPlaneServices
  const app = HostedWorkspaceRoutes(services, {
    authConfig,
    verifier,
    relayUrl: "https://relay.test",
    // Never let a route test reach for a real Convex deployment: the default
    // counter resolves url/token from process.env at call time.
    countActiveOrgSandboxLeases: async () => 0,
    ...opts.options,
  })
  return { app, authority, ensure }
}

function createRequest(token = "user_1") {
  return new Request("http://cp.test/create", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ projectId: "proj_1", repoUrl: "https://github.com/a/b" }),
  })
}

describe("POST /create rate limiting", () => {
  test("the DEFAULT limit is far tighter than the 120/min control-plane class", async () => {
    // No limiter injected — this asserts the shipped number, which is the point:
    // a create provisions a VM, a heartbeat patches a row.
    const { app, authority, ensure } = buildApp()

    for (let i = 0; i < 5; i++) {
      const res = await app.fetch(createRequest())
      expect(res.status, `create ${i + 1} within the cap must pass`).toBe(200)
    }
    expect(authority.createCloudWorkspace).toHaveBeenCalledTimes(5)

    const limited = await app.fetch(createRequest())
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ error: { code: "control_plane_rate_limited" } })
    // Rejected cheaply: no Convex read, and above all no provisioning.
    expect(authority.usersMe).toHaveBeenCalledTimes(5)
    expect(authority.createCloudWorkspace).toHaveBeenCalledTimes(5)
    expect(ensure).toHaveBeenCalledTimes(5)
  })

  test("rejects before the body is parsed or the driver is consulted", async () => {
    const { app, authority, ensure } = buildApp({
      options: { createWorkspaceRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 1, windowMs: 60_000 }) },
    })
    expect((await app.fetch(createRequest())).status).toBe(200)

    // A malformed body would normally 400 — the limiter runs first, so this is
    // a 429. That ordering is the "reject a flood while it is cheap" property.
    const malformed = await app.fetch(
      new Request("http://cp.test/create", {
        method: "POST",
        headers: { authorization: "Bearer user_1", "content-type": "application/json" },
        body: "not json at all",
      }),
    )
    expect(malformed.status).toBe(429)
    expect(authority.createCloudWorkspace).toHaveBeenCalledTimes(1)
    expect(ensure).toHaveBeenCalledTimes(1)
  })

  test("does not share a budget with the general control-plane limiter", async () => {
    // A create flood must not be able to spend the budget the connection and
    // heartbeat routes rely on, and vice versa.
    const controlPlaneRateLimiter = createFixedWindowConnectionRateLimiter({ limit: 120, windowMs: 60_000 })
    const { app } = buildApp({
      options: {
        controlPlaneRateLimiter,
        createWorkspaceRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 1, windowMs: 60_000 }),
      },
    })
    expect((await app.fetch(createRequest())).status).toBe(200)
    expect((await app.fetch(createRequest())).status).toBe(429)
    // The shared limiter is untouched by the create traffic above.
    expect(controlPlaneRateLimiter.size?.()).toBe(0)
  })

  test("is per-caller, so one flooding user cannot lock out everyone else", async () => {
    const { app } = buildApp({
      options: { createWorkspaceRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 1, windowMs: 60_000 }) },
    })
    expect((await app.fetch(createRequest("user_flood"))).status).toBe(200)
    expect((await app.fetch(createRequest("user_flood"))).status).toBe(429)
    expect((await app.fetch(createRequest("user_innocent"))).status).toBe(200)
  })
})

describe("POST /create per-tenant concurrent lease cap", () => {
  test("refuses a create once the org already holds the cap, before any workspace exists", async () => {
    const { app, authority, ensure } = buildApp({
      options: { sandboxLeaseCap: 3, countActiveOrgSandboxLeases: async () => 3 },
    })
    const res = await app.fetch(createRequest())
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({
      error: { code: "sandbox_lease_limit_reached", activeLeases: 3, limit: 3 },
    })
    // Nothing was created and nothing was provisioned.
    expect(authority.createCloudWorkspace).not.toHaveBeenCalled()
    expect(ensure).not.toHaveBeenCalled()
    expect(authority.auditDeny).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "workspace.create.denied",
        reason: "sandbox_lease_limit_reached",
        metadata: expect.objectContaining({ orgId: "org_of_user_1", activeLeases: 3, cap: 3 }),
      }),
    )
  })

  test("allows a create while the org is under the cap", async () => {
    const { app, authority, ensure } = buildApp({
      options: { sandboxLeaseCap: 3, countActiveOrgSandboxLeases: async () => 2 },
    })
    expect((await app.fetch(createRequest())).status).toBe(200)
    expect(authority.createCloudWorkspace).toHaveBeenCalledTimes(1)
    expect(ensure).toHaveBeenCalledTimes(1)
  })

  test("counts against the caller's ORG, not one global bucket", async () => {
    const seen: Array<string | undefined> = []
    const { app } = buildApp({
      options: {
        sandboxLeaseCap: 1,
        countActiveOrgSandboxLeases: async ({ orgId }) => {
          seen.push(orgId)
          return 0
        },
      },
    })
    await app.fetch(createRequest("user_a"))
    await app.fetch(createRequest("user_b"))
    expect(seen).toEqual(["org_of_user_a", "org_of_user_b"])
  })

  test("keys on the CLERK org claim — the id space the lease rows are stamped with", async () => {
    // The lease's `org_id` column holds the Clerk org claim
    // (convex/schema.ts runtime_leases), NOT the authority's internal org id.
    // Counting in the wrong space returns zero forever, which is a cap that
    // silently never fires — strictly worse than no cap, because it reads as
    // protection. This test is what stops that regression.
    const counter = leaseCounter(0)
    const { app, authority } = buildApp({
      options: { sandboxLeaseCap: 5, countActiveOrgSandboxLeases: counter },
    })
    await app.fetch(createRequest("user_1"))
    expect(counter).toHaveBeenCalledWith({ orgId: "org_of_user_1", ownerSubject: "user_1" })
    expect(authority.resolveOrgId).not.toHaveBeenCalled()
  })

  test("a token with no org claim IS capped, on the subject every signed request carries", async () => {
    // The gap this closes. A personal-account token carries no `org_id` claim,
    // so with `org_id` as the only attribution key the create stamped nothing,
    // `countActiveForOrg` could not see the lease, and this guard returned
    // early — the cap did not bind at all for these callers and the per-isolate
    // rate limiter was their only bound. This test previously asserted exactly
    // that (200, counter never called); it now asserts the fix.
    const counter = leaseCounter(9_999)
    const { app, authority, ensure } = buildApp({
      options: { sandboxLeaseCap: 1, countActiveOrgSandboxLeases: counter },
    })
    const res = await app.fetch(createRequest("noorg_personal"))
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({
      error: { code: "sandbox_lease_limit_reached", activeLeases: 9_999, limit: 1 },
    })
    expect(counter).toHaveBeenCalledWith({ ownerSubject: "noorg_personal" })
    // No fabricated org. `personal:<subject>` in the org key would corrupt every
    // per-org metering aggregate downstream, which is the whole reason the owner
    // is a separate column.
    expect(Object.keys(counter.mock.calls[0]![0]!)).toEqual(["ownerSubject"])
    expect(authority.createCloudWorkspace).not.toHaveBeenCalled()
    expect(ensure).not.toHaveBeenCalled()
    expect(authority.auditDeny).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "workspace.create.denied",
        reason: "sandbox_lease_limit_reached",
        metadata: expect.objectContaining({ ownerSubject: "noorg_personal", activeLeases: 9_999, cap: 1 }),
      }),
    )
  })

  test("a personal caller under the cap still creates", async () => {
    const { app, authority } = buildApp({
      options: { sandboxLeaseCap: 3, countActiveOrgSandboxLeases: async () => 2 },
    })
    expect((await app.fetch(createRequest("noorg_personal"))).status).toBe(200)
    expect(authority.createCloudWorkspace).toHaveBeenCalledTimes(1)
  })

  test("both scopes go to ONE count — a union, never a sum", async () => {
    // `sandboxLeases.countActiveForOrg` takes both and counts a lease matching
    // either exactly once (pinned over a fake db in
    // authority/convex-lease-owner-attribution.test.ts). The route must
    // therefore ask ONCE with both scopes, not add two separate counts together:
    // an org caller's own leases carry both columns, so summing would count each
    // of them twice and halve the effective cap.
    const counter = leaseCounter(2)
    const { app } = buildApp({
      options: { sandboxLeaseCap: 3, countActiveOrgSandboxLeases: counter },
    })
    expect((await app.fetch(createRequest("user_1"))).status).toBe(200)
    expect(counter).toHaveBeenCalledTimes(1)
    expect(counter).toHaveBeenCalledWith({ orgId: "org_of_user_1", ownerSubject: "user_1" })
  })

  test("the count is never taken unscoped, even for an auth with a blank subject", async () => {
    // An unscoped `countActiveForOrg` would count every live lease in the
    // deployment and hand this caller a budget derived from other tenants, so
    // it throws. A signed request always has a subject, so this state is
    // unreachable in production — the guard must still never construct it.
    const counter = leaseCounter(9_999)
    const blankSubject: ClerkVerifier = async (_token, config) => ({
      mode: "signed" as const,
      user: { subject: "   ", tokenIdentifier: `${config.issuer}|blank`, issuer: config.issuer },
    })
    const { app } = buildApp({
      options: { sandboxLeaseCap: 1, countActiveOrgSandboxLeases: counter, verifier: blankSubject },
    })
    expect((await app.fetch(createRequest())).status).toBe(200)
    expect(counter).not.toHaveBeenCalled()
  })

  test("an unavailable count does not block the create (the Convex write that follows fails anyway)", async () => {
    const { app, authority } = buildApp({
      options: { sandboxLeaseCap: 1, countActiveOrgSandboxLeases: async () => undefined },
    })
    expect((await app.fetch(createRequest())).status).toBe(200)
    expect(authority.createCloudWorkspace).toHaveBeenCalledTimes(1)
  })

  test("an unavailable count fails open for a personal caller too", async () => {
    // The fail-open is deliberate and must not have been narrowed to the org
    // path: the count comes from the same Convex deployment as the
    // `createCloudWorkspace` write two lines later, so blocking here would turn
    // a Convex blip into a create outage rather than preventing anything.
    const { app, authority } = buildApp({
      options: { sandboxLeaseCap: 1, countActiveOrgSandboxLeases: async () => undefined },
    })
    expect((await app.fetch(createRequest("noorg_personal"))).status).toBe(200)
    expect(authority.createCloudWorkspace).toHaveBeenCalledTimes(1)
  })

  test("a cap of 0 disables the check entirely", async () => {
    const counter = leaseCounter(9_999)
    const { app } = buildApp({ options: { sandboxLeaseCap: 0, countActiveOrgSandboxLeases: counter } })
    expect((await app.fetch(createRequest())).status).toBe(200)
    expect(counter).not.toHaveBeenCalled()
  })
})

describe("POST /create lease attribution — what makes the cap countable", () => {
  test("a personal create stamps an owner and NO metering identity", async () => {
    const { app } = buildApp({ options: { sandboxLeaseCap: 5 } })
    expect((await app.fetch(createRequest("noorg_personal"))).status).toBe(200)
    await settleLeaseAttribution()

    expect(recordSandboxLeaseTenant).toHaveBeenCalledTimes(1)
    const stamped = recordSandboxLeaseTenant.mock.calls[0]![0]!
    expect(stamped.owner_subject).toBe("noorg_personal")
    // The W5 pair must stay absent rather than be filled with a synthesized org:
    // `sandbox_lease_events` and the per-org rollups are keyed on `org_id`, and a
    // fabricated one corrupts every aggregate downstream.
    expect(stamped.metering).toBeUndefined()
    // Nothing org-shaped smuggled in under another name either.
    expect(Object.keys(stamped)).toEqual(["workspace_id", "owner_subject"])
  })

  test("an org create stamps both, so metering is unchanged", async () => {
    const { app } = buildApp({ options: { sandboxLeaseCap: 5 } })
    expect((await app.fetch(createRequest("user_1"))).status).toBe(200)
    await settleLeaseAttribution()

    expect(recordSandboxLeaseTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        owner_subject: "user_1",
        metering: { org_id: "org_of_user_1", user_id: "user_1" },
      }),
    )
  })

  test("the owner stamped is the SAME id the cap counts on", async () => {
    // The cap reads a column somebody else writes. If the create stamped one id
    // space and the count keyed on another the result is zero forever — a cap
    // that reads as protection and never fires. That failure already has a test
    // for the org claim; this is its owner-subject twin.
    const counter = leaseCounter(0)
    const { app } = buildApp({
      options: { sandboxLeaseCap: 5, countActiveOrgSandboxLeases: counter },
    })
    await app.fetch(createRequest("noorg_personal"))
    await settleLeaseAttribution()

    const counted = (counter.mock.calls[0]![0] as { ownerSubject?: string }).ownerSubject
    const stamped = (recordSandboxLeaseTenant.mock.calls[0]![0] as { owner_subject?: string }).owner_subject
    expect(counted).toBe(stamped)
  })

  test("a sandbox refused for egress containment stamps nothing — there is no lease", async () => {
    const { app } = buildApp({
      ensure: vi.fn(async () => ({ status: "unavailable", error: "sandbox_egress_uncontained" })),
      options: { sandboxLeaseCap: 5 },
    })
    expect((await app.fetch(createRequest("noorg_personal"))).status).toBe(200)
    await settleLeaseAttribution()
    expect(recordSandboxLeaseTenant).not.toHaveBeenCalled()
  })
})

describe("POST /create workspace id", () => {
  test("mints an unguessable id — two creates in the same millisecond differ", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000)
    try {
      const { app, authority } = buildApp()
      await app.fetch(createRequest())
      await app.fetch(createRequest())
      const ids = authority.createCloudWorkspace.mock.calls.map(
        (call) => ((call as unknown[])[1] as { workspaceId: string }).workspaceId,
      )
      expect(ids).toHaveLength(2)
      // The old `ws_${Date.now().toString(36)}` returns the same string for
      // both of these, which is exactly the Chain A enumeration weakness.
      expect(ids[0]).not.toBe(ids[1])
      for (const id of ids) {
        expect(id).toMatch(/^ws_[A-Za-z0-9_-]+$/)
        expect(id.length).toBeGreaterThan(`ws_${(1_700_000_000_000).toString(36)}`.length)
      }
    } finally {
      now.mockRestore()
    }
  })
})

// ——— Structural ratchet ———

const routeSource = fs.readFileSync(path.join(import.meta.dirname, "workspace.ts"), "utf8")

/**
 * Comments in this file NAME the things the ordering assertions look for ("…
 * before `sandboxManager.ensure`"), so prose would otherwise satisfy — or
 * falsify — a check about code. Strip whole-line `//` comments and `/* *​/`
 * blocks; every comment in this module sits on its own line, and leaving inline
 * ones alone keeps URLs in string literals intact.
 */
function code(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
}

/**
 * Split the Hono chain into one segment per registered route. Every entry is a
 * chained method call at a fixed indent, so the text between one registration
 * and the next IS that route's handler.
 */
function routeSegments(source = routeSource) {
  const pattern = /^ {6}\.(get|post|put|patch|delete)\("([^"]*)"/gm
  const marks: Array<{ method: string; routePath: string; index: number }> = []
  for (const match of source.matchAll(pattern)) {
    marks.push({ method: match[1]!, routePath: match[2]!, index: match.index! })
  }
  return marks.map((mark, i) => ({
    ...mark,
    source: source.slice(mark.index, marks[i + 1]?.index ?? source.length),
  }))
}

/**
 * `connectionResponse` is the ONE permitted delegate: the three connection
 * routes share it, and it calls the limiter as its first act. A separate test
 * pins that, so admitting it here does not weaken the ratchet.
 */
const RATE_LIMIT_DELEGATES = ["connectionResponse"]

function mutatingRoutesMissingRateLimit(source = routeSource) {
  return routeSegments(source)
    .filter((segment) => segment.method !== "get")
    .filter((segment) => {
      const body = code(segment.source)
      if (body.includes("controlPlaneRateLimitError")) return false
      return !RATE_LIMIT_DELEGATES.some((delegate) => body.includes(`${delegate}(c`))
    })
    .map((segment) => `${segment.method.toUpperCase()} ${segment.routePath}`)
}

describe("hosted-workspace mutating routes are all rate limited", () => {
  test("the segmenter actually sees the routes (guard against a silently empty ratchet)", () => {
    const segments = routeSegments()
    expect(segments.length).toBeGreaterThanOrEqual(9)
    expect(segments.map((segment) => segment.routePath)).toContain("/create")
    expect(segments.filter((segment) => segment.method === "post").length).toBeGreaterThanOrEqual(6)
  })

  test("the ratchet actually fires on an unlimited mutating route", () => {
    // Proves the check below can fail. A structural guard that cannot detect
    // the thing it guards against is worse than no guard: it reads as coverage.
    // This synthetic source is exactly the shape `POST /create` had before the
    // 2026-07-27 review.
    const regressed = [
      "  return (",
      "    new Hono()",
      '      .post("/create", async (c) => {',
      "        const auth = await signedOrError(c.req.raw)",
      "        return c.json(await requireAuthority(services).createCloudWorkspace(auth, {}))",
      "      })",
      '      .post("/:id/user-hosted/heartbeat", async (c) => {',
      "        const rateLimit = await controlPlaneRateLimitError(services, limiter, auth, {})",
      "        return c.json({})",
      "      })",
      "  )",
    ].join("\n")
    expect(mutatingRoutesMissingRateLimit(regressed)).toEqual(["POST /create"])
  })

  test("every mutating route calls controlPlaneRateLimitError, directly or through connectionResponse", () => {
    // A new mutating route with no limiter lands here. Do not add it to an
    // allowlist — add the limiter. `POST /create` provisioned real VMs with no
    // limiter for the entire life of the hosted control plane because nothing
    // was watching this.
    expect(mutatingRoutesMissingRateLimit()).toEqual([])
  })

  test("the connectionResponse delegate rate limits before it reads Convex", () => {
    const delegate = code(
      routeSource.slice(
        routeSource.indexOf("const connectionResponse ="),
        routeSource.indexOf("return (\n    new Hono()"),
      ),
    )
    expect(delegate).toContain("controlPlaneRateLimitError")
    expect(delegate.indexOf("controlPlaneRateLimitError")).toBeLessThan(delegate.indexOf("hostedConnectionInfo"))
  })

  test("the create route rate limits before it touches Convex or the sandbox manager", () => {
    const create = code(routeSegments().find((segment) => segment.routePath === "/create")!.source)
    const limitAt = create.indexOf("controlPlaneRateLimitError")
    expect(limitAt).toBeGreaterThan(-1)
    for (const expensive of ["requireAuthority(services)", "sandboxManager", "createCloudWorkspace"]) {
      expect(limitAt, `rate limit must precede ${expensive}`).toBeLessThan(create.indexOf(expensive))
    }
    // And the durable cap runs before the workspace doc is written.
    expect(create.indexOf("sandboxLeaseCapError")).toBeLessThan(create.indexOf("createCloudWorkspace"))
  })

  test("no route mints a workspace id from the clock alone", () => {
    expect(code(routeSource)).not.toMatch(/`ws_\$\{Date\.now/)
    expect(code(routeSource)).toContain("newWorkspaceId()")
  })
})

// ——— The durable half: the real Convex handler over a fake db ———

function handler(fn: unknown) {
  return (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler
}

/**
 * W5: `countActiveForOrg` reads scoped `by_org_status` / `by_owner_subject_status`
 * index ranges instead of scanning `runtime_leases`, so this double resolves
 * index names against the real convex/schema.ts (`convex-index-harness.ts`).
 * A wrong index name or an out-of-order comparison throws rather than quietly
 * behaving like the old full scan — which is what makes the counts asserted
 * below evidence that the conversion is behavior-preserving.
 *
 * Distinct `_id`s are assigned here because the handler now DEDUPLICATES by
 * document id: the org and owner-subject ranges overlap, and a lease matching
 * both must be counted once. Fixtures sharing an id would hide a double-count.
 */
function leaseDb(rows: Array<Record<string, unknown>>) {
  const seeded = rows.map((row, index) => ({ _id: `lease_${index + 1}`, ...row }))
  return {
    query: (table: string) => ({
      withIndex: (name: string, build: (q: unknown) => unknown) => {
        const { builder, checks } = indexRangeBuilder(table, name)
        build(builder)
        const matching = seeded.filter((row) => checks.every((check) => check(row as never)))
        return {
          collect: async () => matching,
          take: async (limit: number) => matching.slice(0, limit),
        }
      },
      collect: async () => seeded,
    }),
  }
}

function lease(input: Record<string, unknown>) {
  return {
    workspace_id: "ws_x",
    home_region: "us-east",
    driver: "fetch",
    epoch: 1,
    status: "ready",
    retry_count: 0,
    created_at: 1_000,
    updated_at: 1_000,
    ...input,
  }
}

describe("convex sandboxLeases.countActiveForOrg", () => {
  const prevToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN

  function withServiceToken<T>(run: () => T): T {
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "svc_secret"
    try {
      return run()
    } finally {
      if (prevToken === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
      else process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = prevToken
    }
  }

  test("counts only the org's live leases", async () => {
    await withServiceToken(async () => {
      const db = leaseDb([
        lease({ org_id: "org_1", status: "ready" }),
        lease({ org_id: "org_1", status: "acquiring" }),
        // Another tenant — must never leak into this org's budget.
        lease({ org_id: "org_2", status: "ready" }),
        // Terminal states hold nothing.
        lease({ org_id: "org_1", status: "stopped" }),
        lease({ org_id: "org_1", status: "unavailable" }),
        lease({ org_id: "org_1", status: "destroyed" }),
        // Closed interval: the resource is already released.
        lease({ org_id: "org_1", status: "ready", ended_at: 5_000 }),
        // Unattributed lease: counting it against an arbitrary org is worse
        // than not counting it.
        lease({ status: "ready" }),
      ])
      await expect(
        handler(countActiveForOrg)({ db } as never, { service_token: "svc_secret", org_id: "org_1" } as never),
      ).resolves.toEqual({ org_id: "org_1", active: 2 })
    })
  })

  test("an org with nothing running counts zero", async () => {
    await withServiceToken(async () => {
      const db = leaseDb([lease({ org_id: "org_2", status: "ready" })])
      await expect(
        handler(countActiveForOrg)({ db } as never, { service_token: "svc_secret", org_id: "org_1" } as never),
      ).resolves.toEqual({ org_id: "org_1", active: 0 })
    })
  })

  test("acquiring counts — an unfinished cold start is already costing a VM", async () => {
    await withServiceToken(async () => {
      const db = leaseDb([
        lease({ org_id: "org_1", status: "acquiring" }),
        lease({ org_id: "org_1", status: "acquiring" }),
      ])
      await expect(
        handler(countActiveForOrg)({ db } as never, { service_token: "svc_secret", org_id: "org_1" } as never),
      ).resolves.toEqual({ org_id: "org_1", active: 2 })
    })
  })

  test("rejects a wrong service token", async () => {
    await withServiceToken(async () => {
      const db = leaseDb([lease({ org_id: "org_1" })])
      await expect(
        handler(countActiveForOrg)({ db } as never, { service_token: "wrong", org_id: "org_1" } as never),
      ).rejects.toThrow("Unauthenticated")
    })
  })
})
