import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import { BillingRoutes, POLAR_INTERACTIVE_TIMEOUT_MS, type PolarClientLike } from "./routes"
import type { ApplyPolarStateArgs, BillingStore, EntitlementStateRef } from "./store"
import { signStandardWebhook } from "./standard-webhooks"
import {
  BillingEntitlementError,
  createEntitlementGate,
  entitlementDecision,
  requireEntitlement,
} from "./entitlement"
import { hostedConnectionInfo } from "../connections/hosted-connection-info"
import type { ClerkVerifier, ControlPlaneAuthConfig, SignedControlPlaneAuth } from "../platform/auth/auth"
import type { ControlPlaneServices } from "../authority/services"
import type { SandboxManager } from "@claxedo/sandbox-manager"
// REAL Convex billing + orgs handlers — the same in-memory harness the D5/D6
// policy suite exercises (convex-billing-policy.test.ts). Nothing here re-mocks
// billing logic: the store adapter below drives these against ONE shared db.
import { applyPolarState, checkoutContext, entitlementState } from "../../../../convex/billing"
import { applyClerkWebhook } from "../../../../convex/orgs"

/**
 * WAVE 3 — END-TO-END SUBSCRIPTION LIFECYCLE REHEARSAL (integration level).
 *
 * Drives the full cloud-subscription lifecycle through REAL route handlers and
 * REAL Convex billing logic. Only two boundaries are mocked — the true externals:
 *   1. the Polar SDK network client (PolarClientLike), and
 *   2. the sandbox VM driver (SandboxManager.ensure).
 * Everything else is real: the billing routes, the Standard-Webhooks signature
 * verify (webhook bodies carry REAL valid HMAC signatures), the Convex
 * applyPolarState/entitlementState/checkoutContext mutations, the org-membership
 * mirror (applyClerkWebhook), the requireEntitlement gate + seat math.
 *
 * The store is a thin adapter (BillingStore-over-real-Convex) whose methods call
 * the actual convex/billing.ts + convex/orgs.ts handlers against ONE shared
 * in-memory db, so webhook → applyPolarState → entitlementState all mutate/read
 * the SAME org row. Steps run sequentially and assert real state transitions.
 */

// ── The in-memory Convex db mock (verbatim from convex-billing-policy.test.ts;
//    it runs the REAL handlers, it does not fake their logic) ─────────────────
type Row = Record<string, unknown> & { _id: string }

function makeDb(seed: Record<string, Row[]> = {}) {
  const rows: Record<string, Row[]> = Object.fromEntries(
    Object.entries(seed).map(([key, value]) => [key, value.map((row) => ({ ...row }))]),
  )
  let nextId = 1
  const find = (id: unknown) => {
    for (const table of Object.keys(rows)) {
      const row = rows[table]!.find((item) => item._id === id)
      if (row) return { table, row }
    }
    return undefined
  }
  return {
    rows,
    query(table: string) {
      const filters: Array<[string, unknown]> = []
      const query = {
        withIndex(_name: string, build: (q: { eq: (key: string, value: unknown) => unknown }) => unknown) {
          build({
            eq(key, value) {
              filters.push([key, value])
              return this
            },
          })
          return query
        },
        async collect() {
          return (rows[table] ?? []).filter((row) => filters.every(([key, value]) => row[key] === value))
        },
        async unique() {
          return (await query.collect())[0] ?? null
        },
      }
      return query
    },
    async get(id: unknown) {
      return find(id)?.row ?? null
    },
    async insert(table: string, doc: Record<string, unknown>) {
      const _id = `${table}_${nextId++}`
      rows[table] = rows[table] ?? []
      rows[table]!.push({ _id, ...doc })
      return _id
    },
    async patch(id: unknown, patch: Record<string, unknown>) {
      const found = find(id)
      if (!found) throw new Error(`Missing row ${String(id)}`)
      Object.assign(found.row, patch)
    },
    async delete(id: unknown) {
      const found = find(id)
      if (!found) throw new Error(`Missing row ${String(id)}`)
      rows[found.table]!.splice(rows[found.table]!.indexOf(found.row), 1)
    },
  }
}

function handler(fn: unknown) {
  return (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<any> })._handler
}

const SERVICE_TOKEN = "svc_lifecycle_token"
const SECRET = "polar-lifecycle-secret"
const ENV = {
  CLAXEDO_POLAR_WEBHOOK_SECRET: SECRET,
  CLAXEDO_POLAR_ACCESS_TOKEN: "polar_at_test",
  CLAXEDO_POLAR_PRODUCT_MONTHLY: "prod_monthly",
  CLAXEDO_POLAR_PRODUCT_YEARLY: "prod_yearly",
}

const authConfig: ControlPlaneAuthConfig = {
  enabled: true,
  issuer: "https://clerk.test",
  jwksUrl: "https://clerk.test/jwks",
}

// Bearer convention "subject@clerkOrg": the verifier parses it; the store
// adapter maps the same subject to the seeded Clerk user (token_identifier
// `clerk:<subject>`), so route → checkoutContext resolves the SAME user row.
const verifier: ClerkVerifier = async (token) => {
  const [subject, org] = token.split("@")
  return {
    mode: "signed" as const,
    user: {
      subject: subject!,
      tokenIdentifier: `clerk:${subject}`,
      issuer: "https://clerk.test",
      ...(org ? { orgId: org.split("/")[0]! } : {}),
    },
  }
}

const previousServiceToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
beforeAll(() => {
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = SERVICE_TOKEN
})
afterAll(() => {
  if (previousServiceToken === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
  else process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = previousServiceToken
})

// One shared db + one store adapter over the REAL convex handlers.
const db = makeDb()

function identityFor(bearer: string) {
  const subject = bearer.split("@")[0]!
  const issuer = process.env.CLERK_JWT_ISSUER_DOMAIN ?? process.env.CLERK_JWT_ISSUER ?? "clerk"
  return { tokenIdentifier: `clerk:${subject}`, subject, issuer }
}

const store: BillingStore = {
  async entitlementState(ref: EntitlementStateRef) {
    return await handler(entitlementState)(
      { db },
      {
        service_token: SERVICE_TOKEN,
        ...(ref.orgId ? { org_id: ref.orgId } : {}),
        ...(ref.clerkOrgId ? { clerk_org_id: ref.clerkOrgId } : {}),
      },
    )
  },
  async applyPolarState(args: ApplyPolarStateArgs) {
    return await handler(applyPolarState)({ db }, { service_token: SERVICE_TOKEN, ...args })
  },
  async checkoutContext(userToken: string, clerkOrgId?: string) {
    const identity = identityFor(userToken)
    return await handler(checkoutContext)(
      { db, auth: { getUserIdentity: async () => identity }, identity },
      { ...(clerkOrgId ? { clerk_org_id: clerkOrgId } : {}) },
    )
  },
  async listReconcileFlagged() {
    return []
  },
  async listDeletedWithSubscription() {
    return []
  },
}

// The Polar SDK client — MOCKED (network boundary #1). Reused across the whole
// lifecycle so checkout call counts accumulate on ONE spy (F2 assertion).
const polar = {
  checkouts: {
    create: vi.fn(async () => ({ id: "chk_life", url: "https://polar.sh/checkout/chk_life" })),
  },
  customerSessions: {
    create: vi.fn(async () => ({ token: "cs_tok", customerPortalUrl: "https://polar.sh/portal/cs_life" })),
  },
  customers: {
    getState: vi.fn(async () => ({ id: "cus_lifecycle", modified_at: "2026-07-12T00:00:00Z", active_subscriptions: [] })),
  },
  subscriptions: {
    revoke: vi.fn(async () => ({})),
  },
} as unknown as PolarClientLike & {
  checkouts: { create: ReturnType<typeof vi.fn> }
  customerSessions: { create: ReturnType<typeof vi.fn> }
}

function billingApp() {
  return BillingRoutes({ env: ENV, authConfig, verifier, store, polar })
}

function checkoutRequest(bearer: string | undefined, body: unknown) {
  return new Request("http://cp.test/checkout", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
  })
}

async function webhookRequest(payload: string) {
  const timestampSeconds = Math.floor(Date.now() / 1000)
  const signature = await signStandardWebhook({ payload, id: "msg_life", timestampSeconds, secret: SECRET })
  return new Request("http://cp.test/polar/webhook", {
    method: "POST",
    body: payload,
    headers: {
      "webhook-id": "msg_life",
      "webhook-timestamp": String(timestampSeconds),
      "webhook-signature": signature,
    },
  })
}

// The REAL entitlement gate + real requireEntitlement, reading the REAL mirror.
const gate = createEntitlementGate({ env: ENV, store })
async function entitlementThrow(ref: EntitlementStateRef): Promise<BillingEntitlementError | undefined> {
  try {
    await requireEntitlement(ref, "cloud-workspace", { reader: (r) => store.entitlementState(r) })
    return undefined
  } catch (err) {
    if (err instanceof BillingEntitlementError) return err
    throw err
  }
}

// Wake-path (choke point #2) harness: the sandbox VM driver is MOCKED (network
// boundary #2). The route + authorization + entitlement gate are all REAL.
const wakeAuth = {
  mode: "signed",
  token: "alice@org_a",
  user: { subject: "alice", tokenIdentifier: "clerk:alice", issuer: "https://clerk.test" },
} as unknown as SignedControlPlaneAuth

function wakeServices(ensure: ReturnType<typeof vi.fn>) {
  return {
    authority: {
      usersMe: vi.fn(async () => ({ subject: "alice" })),
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { backing: "cloud-vm", access: "cloud", home_region: "us-east" },
      })),
      auditDeny: vi.fn(async () => ({})),
    },
    sandbox: { sandboxManager: { ensure } as unknown as SandboxManager },
    telemetry: { capture: vi.fn() },
  } as unknown as ControlPlaneServices
}

let orgDocId: string

describe("cloud subscription lifecycle (integration rehearsal)", () => {
  test("1. signup + org: real Clerk mirror seeds user/org/owner; org starts free / not entitled", async () => {
    // Real applyClerkWebhook path (org + membership mirror).
    await handler(applyClerkWebhook)({ db }, {
      type: "user.created",
      data: { id: "alice", email_addresses: [{ email_address: "alice@acme.test" }], first_name: "Alice" },
    })
    await handler(applyClerkWebhook)({ db }, {
      type: "organization.created",
      data: { id: "org_a", name: "Acme", slug: "acme", updated_at: 1 },
    })
    await handler(applyClerkWebhook)({ db }, {
      type: "organizationMembership.created",
      data: {
        organization: { id: "org_a", name: "Acme", updated_at: 2 },
        public_user_data: { user_id: "alice" },
        role: "org:admin",
        updated_at: 2,
      },
    })

    const orgRow = db.rows.orgs!.find((row) => row.clerk_org_id === "org_a")!
    expect(orgRow).toBeDefined()
    expect(orgRow.kind).toBe("clerk")
    orgDocId = orgRow._id

    const state = await store.entitlementState({ orgId: orgDocId })
    expect(state).toMatchObject({ found: true, org_id: orgDocId, member_count: 1 })
    expect((state as { plan?: string }).plan).not.toBe("pro")
    // The real predicate: a fresh org is NOT entitled (free tier, fail-closed).
    const denied = await entitlementThrow({ orgId: orgDocId })
    expect(denied?.code).toBe("billing_entitlement_required")
  })

  test("2. subscribe (trial): owner checkout keys org_{id} (F9); trialing webhook flips the mirror to pro", async () => {
    // ── /checkout: real route, real admin/seat context, mocked Polar ──────────
    const res = await billingApp().request(checkoutRequest("alice@org_a", { plan: "monthly" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ url: "https://polar.sh/checkout/chk_life", orgId: orgDocId, seats: 1 })
    expect(polar.checkouts.create).toHaveBeenCalledTimes(1)
    expect(polar.checkouts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        products: ["prod_monthly"],
        externalCustomerId: `org_${orgDocId}`, // F9: keyed on the ORG, not the admin
        metadata: { org_id: orgDocId },
      }),
      // The interactive deadline rides every user-facing Polar call.
      { timeoutMs: POLAR_INTERACTIVE_TIMEOUT_MS },
    )

    // ── deliver the subscription: real signature verify → real applyPolarState ─
    const payload = JSON.stringify({
      type: "customer.state_changed",
      data: {
        id: "cus_lifecycle",
        modified_at: "2026-07-12T10:00:00.000Z",
        active_subscriptions: [
          {
            id: "sub_life",
            status: "trialing",
            product_id: "prod_monthly",
            seats: 1,
            modified_at: "2026-07-12T10:00:00.000Z",
            current_period_end: "2026-08-12T10:00:00.000Z",
            metadata: { org_id: orgDocId },
          },
        ],
      },
    })
    const hook = await billingApp().request(await webhookRequest(payload))
    expect(hook.status).toBe(200)
    expect(await hook.json()).toMatchObject({ received: true, results: [{ org_id: orgDocId, applied: true }] })

    // The SHARED org row is now pro/trialing, seat-licensed 1, grace unset.
    const state = await store.entitlementState({ orgId: orgDocId })
    expect(state).toMatchObject({
      found: true,
      plan: "pro",
      subscription_status: "trialing",
      seats_licensed: 1,
      member_count: 1,
    })
    expect((state as { past_due_since?: number }).past_due_since).toBeUndefined()
  })

  test("3. entitled cloud workspace: real decision ALLOWS while trialing (gate + full wake route)", async () => {
    // Pure predicate + gate (create choke-point decision).
    expect(await entitlementThrow({ orgId: orgDocId })).toBeUndefined()
    expect(await gate({ orgId: orgDocId }, "cloud-workspace")).toBeUndefined()

    // Full wake/resume route (choke point #2), sandbox driver mocked.
    const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
    const result = await hostedConnectionInfo(
      wakeServices(ensure),
      {
        defaultHomeRegion: "us-east" as const,
        relayUrl: "wss://relay.test",
        requireCloudWorkspaceEntitlement: async () => gate({ orgId: orgDocId }, "cloud-workspace"),
      },
      wakeAuth,
      "ws_life",
    )
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ connection: { status: "provisioning" } })
  })

  test("4. seat limit (F1): 2nd member syncs cleanly, then entitlement DENIES seat_over_capacity", async () => {
    await handler(applyClerkWebhook)({ db }, {
      type: "user.created",
      data: { id: "bob", email_addresses: [{ email_address: "bob@acme.test" }], first_name: "Bob" },
    })
    // The mirror must NOT throw on an over-seat join (F1 regression).
    await expect(
      handler(applyClerkWebhook)({ db }, {
        type: "organizationMembership.created",
        data: {
          organization: { id: "org_a", name: "Acme", updated_at: 3 },
          public_user_data: { user_id: "bob" },
          role: "org:member",
          updated_at: 3,
        },
      }),
    ).resolves.toEqual({ ok: true })

    const state = await store.entitlementState({ orgId: orgDocId })
    expect(state).toMatchObject({ member_count: 2, seats_licensed: 1 })

    // Real seat math: 2 members > 1 licensed seat → typed denial with the counts.
    const denied = await entitlementThrow({ orgId: orgDocId })
    expect(denied?.code).toBe("seat_over_capacity")
    expect(denied?.details).toEqual({ memberCount: 2, seatsLicensed: 1 })

    // A seatless (personal) org is never seat-limited (real entitlement.ts branch).
    const seatless = entitlementDecision(
      { found: true, org_id: "org_personal", plan: "pro", subscription_status: "active", member_count: 5 },
      "cloud-workspace",
    )
    expect(seatless).toEqual({ entitled: true, status: "active" })
  })

  test("5. already-subscribed guard (F2): a 2nd checkout is 409 with NO new Polar call", async () => {
    const callsBefore = polar.checkouts.create.mock.calls.length
    const res = await billingApp().request(checkoutRequest("alice@org_a", { plan: "monthly" }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: { code: "billing_already_subscribed" } })
    expect(polar.checkouts.create.mock.calls.length).toBe(callsBefore) // no double-bill
  })

  test("6. cancel: a real-signed subscription.canceled (newer ts) flips the mirror to free/canceled", async () => {
    const payload = JSON.stringify({
      type: "subscription.canceled",
      data: {
        id: "sub_life",
        status: "canceled",
        product_id: "prod_monthly",
        customer_id: "cus_lifecycle",
        modified_at: "2026-07-13T10:00:00.000Z",
        metadata: { org_id: orgDocId },
      },
    })
    const hook = await billingApp().request(await webhookRequest(payload))
    expect(hook.status).toBe(200)
    expect(await hook.json()).toMatchObject({ received: true, results: [{ org_id: orgDocId, applied: true }] })

    const state = await store.entitlementState({ orgId: orgDocId })
    expect(state).toMatchObject({ found: true, plan: "free", subscription_status: "canceled" })
  })

  test("7. revoke (F3): canceled org is DENIED at BOTH create-decision and wake route", async () => {
    // Create-side decision (choke point #1 predicate).
    const denied = await entitlementThrow({ orgId: orgDocId })
    expect(denied?.code).toBe("billing_entitlement_required")
    expect(await gate({ orgId: orgDocId }, "cloud-workspace")).toMatchObject({ status: 402 })

    // Wake/resume route (choke point #2): the sandbox is NEVER woken.
    const ensure = vi.fn()
    const result = await hostedConnectionInfo(
      wakeServices(ensure),
      {
        defaultHomeRegion: "us-east" as const,
        relayUrl: "wss://relay.test",
        requireCloudWorkspaceEntitlement: async () => gate({ orgId: orgDocId }, "cloud-workspace"),
      },
      wakeAuth,
      "ws_life",
    )
    expect(result).toMatchObject({ status: 402, error: { code: "billing_entitlement_required" } })
    expect(ensure).not.toHaveBeenCalled()
  })

  test("8. F6 sanity: a reconciliation confirming unchanged state clears the reconcile flag", async () => {
    const orgRow = db.rows.orgs!.find((row) => row._id === orgDocId)!
    orgRow.billing_reconcile_flagged_at = 999_999
    const anchoredTs = orgRow.polar_state_modified_at as number
    const result = await store.applyPolarState({
      polar_customer_id: "cus_lifecycle",
      source_ts: anchoredTs, // equal → not newer: unchanged-state reconciliation
      source: "reconciliation",
      org_states: [],
    })
    expect(result.results[0]).toMatchObject({ applied: false, reason: "stale_source_reconcile_confirmed" })
    expect(orgRow.billing_reconcile_flagged_at).toBeUndefined()
  })
})
