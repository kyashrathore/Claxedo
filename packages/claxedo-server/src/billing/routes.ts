/**
 * Polar billing routes for the hosted control plane (ADR 014 addendum:
 * Option B — raw `@polar-sh/sdk`, our own webhook route,
 * everything Polar confined to src/billing/**).
 *
 * Mounted by hosted-app.ts at /api/billing:
 *   POST /api/billing/polar/webhook  — Standard-Webhooks-verified state intake
 *   POST /api/billing/checkout       — Polar checkout session (admin/owner)
 *   POST /api/billing/portal         — Polar customer portal session (admin/owner)
 *
 * Customer linkage (ADR addendum): NO customer pre-creation — Polar
 * creates the customer lazily at first checkout with `external_customer_id` =
 * a STABLE ORG-scoped id (`org_{orgId}`), NOT the purchasing admin's Clerk
 * subject. Keying on the org (not the human) means any admin of the org reaches
 * the same Polar customer/portal, and a second admin cannot mint a second
 * customer for the same org. `metadata.org_id` (the Convex org doc id) still
 * rides the checkout onto the subscription and is how webhook state re-attaches
 * to the org.
 *
 * Every failure path reports through reportPaymentError (payment page
 * class). Fail-closed everywhere: missing secret/config → 503, bad signature
 * → 401 and the state is never applied.
 */

import { cleanString as clean } from "../platform/runtime/lib/strings"
import { Hono } from "hono"
import { z } from "zod"
import { Polar } from "@polar-sh/sdk"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
} from "../platform/auth/auth"
import { createFixedWindowConnectionRateLimiter, type ConnectionRateLimiter } from "../platform/auth/rate-limit"
import type { RouteGuardExemption } from "../platform/auth/request-guard"
import { durableIdempotencyStore, type DurableIdempotencyStore } from "../authority/http/idempotency"
import { polarWebhookCacheKey } from "./polar-webhook-dedup"
import { reportPaymentError } from "../platform/telemetry/errors/report"
import { createBillingStore, type BillingStore, type CheckoutContext } from "./store"
import { webhookEventToApplyArgs, isBillingRelevantEventType, type PolarProductConfig } from "./apply-polar-state"
import { verifyStandardWebhook, WebhookSignatureError } from "./standard-webhooks"

export type BillingEnv = Record<string, string | undefined>

/**
 * Structural slice of `@polar-sh/sdk`'s Polar client used here — tests inject
 * a fetch-stubbed instance (the SDK's HTTPClient takes a custom fetcher), or
 * any object satisfying this shape.
 */
/**
 * Per-call deadline for every Polar request.
 *
 * `@polar-sh/sdk` 0.48.1 takes `{ timeoutMs }` as each method's second argument
 * and turns it into a real `AbortSignal.timeout` on the underlying fetch
 * (`lib/sdks.js`: `if (!fetchOptions?.signal && conf.timeoutMs > 0)`). So unlike
 * the Convex `withTimeout` wrapper — which bounds only the caller's wait — this
 * genuinely CANCELS the request. That distinction is why the SDK's own option is
 * used here instead of wrapping the promise: a cancelled Polar call cannot land
 * later, so nothing downstream has to be idempotent against it.
 *
 * Two budgets, because the paths have different callers:
 *
 *   - user-facing (checkout, portal): a person is waiting on a redirect, so the
 *     deadline is short enough to fail visibly rather than hang the tab.
 *   - cron sweeps (reconcile, deleted-org cancel): these iterate SERIALLY over
 *     flagged orgs, so one untimed call stalls the whole sweep and every org
 *     behind it — the reason these were the genuine gap the review found. A
 *     slightly longer per-call budget is fine; an unbounded one is not.
 */
export const POLAR_INTERACTIVE_TIMEOUT_MS = 10_000
export const POLAR_SWEEP_TIMEOUT_MS = 15_000

/** The SDK's per-call request options; only the deadline is used here. */
export type PolarRequestOptions = { timeoutMs?: number }

export type PolarClientLike = {
  checkouts: {
    create(request: {
      products: string[]
      seats?: number
      externalCustomerId?: string | null
      metadata?: Record<string, string | number | boolean>
      successUrl?: string | null
    }, options?: PolarRequestOptions): Promise<{ id: string; url: string }>
  }
  customerSessions: {
    create(
      request: { externalCustomerId: string },
      options?: PolarRequestOptions,
    ): Promise<{ token: string; customerPortalUrl: string }>
  }
  customers: {
    getState(request: { id: string }, options?: PolarRequestOptions): Promise<unknown>
  }
  subscriptions: {
    /**
     * Immediate cancellation (MoR revoke). Used by the deleted-org sweep:
     * A deleted org is gone, so billing must stop now — not at period end.
     * SDK note: @polar-sh/sdk 0.48.1 exposes `subscriptions.revoke({ id })`
     * for immediate termination; the reconciliation sweep tolerates a failure
     * (leaves the org listed, retries next sweep) so an SDK-shape surprise
     * degrades to bounded retry, never a lost cancel.
     */
    revoke(request: { id: string }, options?: PolarRequestOptions): Promise<unknown>
  }
}


/**
 * Rate-limit key for the unauthenticated webhook: the caller's IP.
 *
 * Same derivation as `authority/request-guard.ts` `requestClientKey` and
 * `routes/hosted-device-auth.ts` `rateLimitClientKey` — `cf-connecting-ip` is
 * set by Cloudflare and unspoofable on the Worker path, with the first
 * `x-forwarded-for` entry as the Node-container fallback. Taken on `Request`
 * rather than a Hono `Context` so it stays usable from the webhook's own tests
 * without constructing a context.
 */
function webhookClientKey(request: Request) {
  return (
    clean(request.headers.get("cf-connecting-ip") ?? undefined) ??
    clean(request.headers.get("x-forwarded-for")?.split(",")[0]) ??
    "anonymous"
  )
}

/**
 * The stable, org-scoped Polar `external_customer_id`. Both checkout and
 * portal derive the customer from the org (never the purchasing admin's Clerk
 * subject), so every admin of the org resolves the SAME Polar customer.
 */
function orgExternalCustomerId(orgId: string) {
  return `org_${orgId}`
}

/** Statuses that mean a live Polar subscription already exists for the org. */
const LIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"])

export function polarProductConfig(env: BillingEnv): PolarProductConfig {
  const ids = [clean(env.CLAXEDO_POLAR_PRODUCT_MONTHLY), clean(env.CLAXEDO_POLAR_PRODUCT_YEARLY)]
    .filter((id): id is string => !!id)
  return {
    knownProductIds: new Set(ids),
    allowAllProductsWhenUnconfigured: clean(env.CLAXEDO_POLAR_SERVER) === "sandbox",
  }
}

/** Real SDK client from env; undefined without an access token (fail closed at routes). */
export function polarClientFromEnv(env: BillingEnv): PolarClientLike | undefined {
  const accessToken = clean(env.CLAXEDO_POLAR_ACCESS_TOKEN)
  if (!accessToken) return undefined
  return new Polar({
    accessToken,
    // Polar test mode rides the sandbox server.
    ...(clean(env.CLAXEDO_POLAR_SERVER) === "sandbox" ? { server: "sandbox" as const } : {}),
  }) as unknown as PolarClientLike
}

export type BillingRouteOptions = {
  env: BillingEnv
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  /** Test seams. Defaults: Convex-backed store; SDK client from env. */
  store?: BillingStore
  polar?: PolarClientLike
  rateLimiter?: ConnectionRateLimiter
  /** W3.3 IP-keyed limiter for the unauthenticated webhook route. */
  webhookRateLimiter?: ConnectionRateLimiter
  /** Override for the webhook body cap, in bytes. Tests shrink it. */
  webhookMaxBodyBytes?: number
  /**
   * Test seam for the webhook dedup store. Production reads the
   * process-wide store installed at hosted composition (`worker.ts`).
   */
  idempotencyStore?: DurableIdempotencyStore
  now?: () => number
}

/**
 * Hard cap on the Polar webhook body.
 *
 * 512 KiB. Polar's largest documented billing event — a subscription with full
 * customer + product + price expansion — is single-digit KiB, so this is ~100x
 * real traffic and still an order of magnitude under the 1 MiB default guard.
 * The webhook is the plane's only unauthenticated write surface, so it takes the
 * TIGHTER number rather than inheriting the general one.
 */
export const POLAR_WEBHOOK_MAX_BODY_BYTES = 512 * 1024

/**
 * This surface's exemption from the app-wide default guard.
 *
 * Declared HERE rather than in `authority/request-guard.ts` because the
 * reason names the payment vendor, and `billing/invariants.test.ts` keeps the
 * vendor-agnostic control-plane core free of Polar tokens. `hosted-app.ts`
 * merges it in through `hostedRouteGuardExemptions()`, so the exemption still
 * lives in exactly one place and is still auditable by the inventory test — it
 * just lives next to the code that enforces the replacement.
 */
export const BILLING_WEBHOOK_GUARD_EXEMPTION = {
  prefix: "/api/billing/polar/webhook",
  bodyCap: true,
  rateLimit: true,
  reason:
    "Polar delivers this route unauthenticated, so it needs an IP-keyed limiter and a content-length precheck that runs BEFORE the body is buffered for signature verification — both tighter than the defaults. The default per-IP limiter would also let a webhook flood spend the budget the rest of the plane shares with that client.",
  enforcedBy: "src/billing/routes.ts (readCappedBody + webhookRateLimiter on POST /polar/webhook)",
} as const satisfies RouteGuardExemption

/**
 * Read the request body with a hard byte ceiling, BEFORE anything buffers it.
 *
 * Why not `hono/body-limit` here: the default guard exempts this route (see
 * BILLING_WEBHOOK_GUARD_EXEMPTION) because the webhook needs its own tighter cap,
 * and this function is also the content-length precheck. Two independent checks
 * on purpose:
 *
 *   1. `content-length` precheck — rejects an oversized declared body without
 *      reading a byte. Cheap, and catches the honest case.
 *   2. Streaming count on the ACTUAL read — a lying or absent content-length
 *      (chunked `transfer-encoding`) must not get a free pass. Without this the
 *      precheck is trivially bypassed by omitting the header, which is why the
 *      cap has to hold on the real bytes and not just the claim about them.
 *
 * The previous code called `c.req.text()` directly, which buffers the WHOLE body
 * into the isolate's memory before signature verification — so an unauthenticated
 * caller chose how much memory the Worker allocated.
 */
export async function readCappedBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; payload: string } | { ok: false }> {
  const declared = request.headers.get("content-length")
  if (declared) {
    const length = Number.parseInt(declared, 10)
    if (Number.isFinite(length) && length > maxBytes) return { ok: false }
  }
  if (!request.body) return { ok: true, payload: "" }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        // Stop pulling immediately — the point is to not hold the rest.
        await reader.cancel().catch(() => {})
        return { ok: false }
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  // The signature is computed over the exact bytes Polar sent, so decode once
  // here and hand the SAME string to both verification and JSON.parse.
  return { ok: true, payload: new TextDecoder().decode(merged) }
}

const checkoutBody = z
  .object({
    plan: z.enum(["monthly", "yearly"]),
    seats: z.number().int().positive().optional(),
  })
  .strict()

function unavailable(message: string) {
  return { error: { code: "billing_unavailable", message } }
}

function providerError() {
  return { error: { code: "billing_provider_error", message: "Polar request failed" } }
}

/**
 * A concurrent delivery of the same `webhook-id` is already being applied
 * in another isolate. Raised so the webhook's existing catch turns it into a 500
 * and Polar retries: the in-flight attempt may still fail, and a 2xx here would
 * consume the only delivery that could have applied the event.
 */
class PolarWebhookInFlightError extends Error {
  constructor() {
    super("Polar webhook delivery is already being applied")
    this.name = "PolarWebhookInFlightError"
  }
}

export function BillingRoutes(options: BillingRouteOptions) {
  const env = options.env
  const store = () => options.store ?? createBillingStore(env)
  const polar = () => options.polar ?? polarClientFromEnv(env)
  const products = polarProductConfig(env)
  // Same fixed-window pattern the workspace routes use (control-plane class):
  // Checkout/portal mint external requests; keep floods off Polar and Convex.
  // Keys on auth.user.subject, so it reaches ONLY /checkout and /portal — the
  // webhook has no principal and gets its own IP-keyed limiter below.
  const rateLimiter = options.rateLimiter ?? createFixedWindowConnectionRateLimiter({ limit: 20, windowMs: 60_000 })
  /**
   * The webhook's own limiter, keyed on the CALLER'S IP.
   *
   * The route is unauthenticated by construction — Polar proves itself with a
   * Standard-Webhooks signature, not a bearer token — so there is no principal
   * to key on and `rateLimiter` above could never cover it. It was therefore the
   * one hosted surface that was both unauthenticated AND unlimited.
   *
   * 120/min is generous against real Polar delivery (a burst of subscription
   * events is single digits) while bounding a flood of unsigned garbage. This
   * limiter runs BEFORE signature verification on purpose: verification is the
   * expensive step (HMAC over the whole body), so gating on it first would mean
   * the flood pays nothing and we pay for every request.
   */
  const webhookRateLimiter =
    options.webhookRateLimiter ?? createFixedWindowConnectionRateLimiter({ limit: 120, windowMs: 60_000 })

  /**
   * Run `apply` at most once per Polar delivery id.
   *
   * Rides the SAME durable store as control-route idempotency
   * (`convex/idempotency.ts`) under a `polar-webhook:` key prefix, rather than a
   * second near-copy of that table: one TTL story, one sweep, one place where
   * lease-expiry-and-takeover is reasoned about.
   *
   * `webhookId` is always present by the time this runs: `verifyStandardWebhook`
   * signs over `id.timestamp.payload` and rejects a missing `webhook-id` with a
   * 401 before this point, so the header is authenticated rather than merely
   * hoped for. The `!webhookId` branch is a type narrowing, not a fallback.
   *
   * One deliberate degradation: with no durable store configured (self-host,
   * tests) the apply runs undeduped. A single process cannot have the
   * cross-isolate problem this exists to fix, and `source_ts` still guards
   * ordering there.
   *
   * The fingerprint is the delivery id itself: unlike a session operation there
   * is no client-chosen key to bind a payload to, and the signature already ties
   * this id to these exact bytes.
   */
  const dedupedWebhook = async <T>(webhookId: string | undefined, apply: () => Promise<T>) => {
    const store = options.idempotencyStore ?? durableIdempotencyStore()
    if (!webhookId || !store) return apply()
    const cacheKey = polarWebhookCacheKey(webhookId)
    const claim = await store.begin({ cacheKey, fingerprint: webhookId })
    if (claim.state === "completed") {
      // Already applied. Replay the recorded response so Polar sees the same ack
      // it would have seen the first time.
      return (claim.resultJson === undefined ? undefined : JSON.parse(claim.resultJson)) as T
    }
    if (claim.state === "in_flight") {
      // A concurrent delivery of the SAME event is mid-apply in another isolate.
      // Throwing here surfaces as the route's 500, which makes Polar retry — the
      // right answer, since the first attempt may yet fail.
      throw new PolarWebhookInFlightError()
    }
    let value: T
    try {
      value = await apply()
    } catch (error) {
      // Release so Polar's retry can apply it, rather than being deduped
      // against a delivery that never succeeded.
      await store.release({ cacheKey, fingerprint: webhookId }).catch(() => {})
      throw error
    }
    await store.complete({
      cacheKey,
      fingerprint: webhookId,
      ...(value === undefined ? {} : { resultJson: JSON.stringify(value) }),
    })
    return value
  }

  /** Signed auth or a ready error response. Billing has no unsigned surface. */
  const signedAuth = async (c: { req: { raw: Request } }): Promise<
    | { auth: SignedControlPlaneAuth }
    | { error: { status: 401 | 403 | 503; body: unknown } }
  > => {
    try {
      const context = await controlPlaneAuthContext(c.req.raw, {
        ...(options.authConfig ? { config: options.authConfig } : {}),
        ...(options.verifier ? { verifier: options.verifier } : {}),
      })
      if (context.mode !== "signed") {
        return {
          error: {
            status: 401,
            body: controlPlaneAuthErrorBody(
              new ControlPlaneAuthError(401, "missing_bearer_token", "Billing routes require signed auth"),
            ),
          },
        }
      }
      return { auth: context }
    } catch (err) {
      if (err instanceof ControlPlaneAuthError) {
        return { error: { status: err.status as 401 | 403 | 503, body: controlPlaneAuthErrorBody(err) } }
      }
      throw err
    }
  }

  /** Resolve the caller's org context and require an admin/owner role. */
  const adminContext = async (auth: SignedControlPlaneAuth): Promise<
    | { context: CheckoutContext }
    | { error: { status: 403 | 503; body: unknown } }
  > => {
    let context: CheckoutContext
    try {
      context = await store().checkoutContext(auth.token, auth.user.orgId)
    } catch (err) {
      reportPaymentError(err, { tags: { source: "billing_checkout_context" } })
      return { error: { status: 503, body: unavailable("Billing state is unavailable") } }
    }
    if (context.role !== "owner" && context.role !== "admin") {
      return {
        error: {
          status: 403,
          body: { error: { code: "billing_admin_required", message: "Org admin or owner role is required" } },
        },
      }
    }
    return { context }
  }

  return (
    new Hono()
      // ── Webhook intake (single-writer path) ────────────────────────────────
      .post("/polar/webhook", async (c) => {
        // Limiter FIRST, before the secret lookup, the body read, and the
        // signature HMAC. Every step after this point costs something an
        // unauthenticated caller should not be able to spend without bound.
        const webhookLimit = webhookRateLimiter.check({
          userId: webhookClientKey(c.req.raw),
          workspaceId: "polar-webhook",
        })
        if (!webhookLimit.allowed) {
          return c.json(
            {
              error: {
                code: "billing_webhook_rate_limited",
                message: "Webhook delivery rate exceeded",
                retryAfterMs: webhookLimit.retryAfterMs,
              },
            },
            429,
          )
        }
        // Cap the body BEFORE buffering it, and before the secret lookup.
        // Previously this was a bare `c.req.text()` further down, so an
        // unauthenticated caller decided how much memory the Worker allocated,
        // ahead of signature verification.
        //
        // Ordering note: the cap runs before the missing-secret 503 so that it
        // cannot be skipped by a CONFIG state. An unconfigured deploy still
        // rejects oversized bodies, which is the property that makes "this route
        // is capped" true unconditionally rather than true-when-configured.
        const body = await readCappedBody(c.req.raw, options.webhookMaxBodyBytes ?? POLAR_WEBHOOK_MAX_BODY_BYTES)
        if (!body.ok) {
          // 413, not 503: this is the caller's fault and Polar must not retry a
          // payload that will be rejected identically every time.
          reportPaymentError(new Error("Polar webhook body exceeded the size cap"), {
            tags: { source: "billing_webhook", reason: "body_too_large" },
          })
          return c.json(
            { error: { code: "billing_webhook_body_too_large", message: "Webhook body exceeds the size limit" } },
            413,
          )
        }
        const secret = clean(env.CLAXEDO_POLAR_WEBHOOK_SECRET)
        if (!secret) {
          // A hosted deploy that lost the secret must be a visible outage —
          // 503 makes Polar retry (and eventually alert us), never 2xx.
          reportPaymentError(new Error("CLAXEDO_POLAR_WEBHOOK_SECRET is not configured"), {
            tags: { source: "billing_webhook" },
          })
          return c.json(unavailable("Webhook secret is not configured"), 503)
        }
        const payload = body.payload
        // The same header the signature is computed over, kept for dedup.
        // Read once so verification and dedup cannot disagree about which
        // delivery this is.
        const webhookId = clean(c.req.header("webhook-id"))
        try {
          await verifyStandardWebhook({
            payload,
            headers: {
              "webhook-id": c.req.header("webhook-id") ?? null,
              "webhook-timestamp": c.req.header("webhook-timestamp") ?? null,
              "webhook-signature": c.req.header("webhook-signature") ?? null,
            },
            secret,
            ...(options.now ? { now: options.now } : {}),
          })
        } catch (err) {
          if (err instanceof WebhookSignatureError) {
            // Unverifiable = unauthenticated (I-4): 401, state never applied.
            reportPaymentError(err, { tags: { source: "billing_webhook", reason: "bad_signature" } })
            return c.json({ error: { code: "invalid_webhook_signature", message: err.message } }, 401)
          }
          throw err
        }

        let event: unknown
        try {
          event = JSON.parse(payload)
        } catch {
          return c.json({ error: { code: "invalid_webhook_payload", message: "Body is not JSON" } }, 400)
        }
        const typedEvent = event as { type?: unknown; data?: unknown }
        const applyArgs = webhookEventToApplyArgs(typedEvent, products)
        if (!applyArgs) {
          // A billing-relevant event we could not translate to an org (missing
          // metadata.org_id / customer id) means a charge may exist with no
          // entitlement — page. A retry cannot fix attribution, so still ack
          // (202) to protect Polar's 10-delivery budget. Harmless event
          // types (order.*, benefit.*) ack silently.
          if (isBillingRelevantEventType(typedEvent)) {
            reportPaymentError(new Error("Unattributable Polar billing event — acked without applying"), {
              tags: { source: "billing_webhook", reason: "unattributable_event" },
              extra: { type: typedEvent.type },
            })
          }
          return c.json({ received: true, applied: false }, 202)
        }

        try {
          // Dedup on `webhook-id`. Until now that header was read only as
          // signature input (`standard-webhooks.ts`), so a redelivery of the same
          // event re-applied it. The existing protection is the single writer's
          // `source_ts` guard (convex/billing.ts), which is last-write-wins on a
          // TIMESTAMP: it correctly no-ops a re-apply at an already-seen ts, but
          // it is a per-org monotonic check, not a delivery-level one, and Polar
          // retries up to 10 times.
          //
          // Both layers stay. `source_ts` is the ordering invariant; this is the
          // delivery-identity one, and it composes with the body cap and IP
          // limiter above rather than replacing either.
          const result = await dedupedWebhook(webhookId, () => store().applyPolarState(applyArgs))
          if (result.unresolved.length > 0) {
            // metadata.org_id pointed at nothing we know — a retry cannot fix
            // it, so ack + page rather than burn Polar's 10-delivery budget.
            reportPaymentError(new Error("Polar webhook referenced unknown org ids"), {
              tags: { source: "billing_webhook", reason: "unresolved_org" },
              extra: { unresolved: result.unresolved },
            })
          }
          return c.json({ received: true, ...result })
        } catch (err) {
          // Mirror write failed (Convex unreachable): 500 so Polar RETRIES —
          // the delivery is good, we were not.
          reportPaymentError(err, { tags: { source: "billing_webhook", reason: "apply_failed" } })
          return c.json(unavailable("Failed to apply billing state"), 500)
        }
      })

      // ── Checkout session (lazy customer creation, ADR 014 addendum) ───────
      .post("/checkout", async (c) => {
        const authResult = await signedAuth(c)
        if ("error" in authResult) return c.json(authResult.error.body as never, authResult.error.status)
        const auth = authResult.auth
        const limit = rateLimiter.check({ userId: auth.user.subject, workspaceId: "billing" })
        if (!limit.allowed) {
          return c.json({ error: { code: "billing_rate_limited", message: "Too many billing requests" } }, 429)
        }
        const parsed = checkoutBody.safeParse(await c.req.json().catch(() => ({})))
        if (!parsed.success) {
          return c.json({ error: { code: "invalid_billing_request", message: parsed.error.message } }, 400)
        }
        const product = parsed.data.plan === "monthly"
          ? clean(env.CLAXEDO_POLAR_PRODUCT_MONTHLY)
          : clean(env.CLAXEDO_POLAR_PRODUCT_YEARLY)
        const client = polar()
        if (!product || !client) {
          reportPaymentError(new Error("Polar checkout is not configured (product ids / access token)"), {
            tags: { source: "billing_checkout" },
          })
          return c.json(unavailable("Billing is not configured on this control plane"), 503)
        }

        const admin = await adminContext(auth)
        if ("error" in admin) return c.json(admin.error.body as never, admin.error.status)
        const context = admin.context

        // Refuse a SECOND checkout when the org already holds a live Polar
        // subscription (active/trialing/past_due) — a second checkout mints a
        // second subscription for the same org and double-bills. The mirrored
        // status (single writer) is authoritative here; direct the caller to
        // the customer portal / seat management instead.
        //
        // PENDING: the mid-cycle SEAT-INCREASE path (a Polar
        // subscription-UPDATE that changes the licensed seat count on the
        // existing subscription) is deliberately NOT implemented here — it
        // depends on confirming Polar's seat-update semantics against the
        // sandbox. Until then "buy more seats" routes through the portal,
        // never through a fresh /checkout.
        if (context.subscription_status && LIVE_SUBSCRIPTION_STATUSES.has(context.subscription_status)) {
          return c.json(
            {
              error: {
                code: "billing_already_subscribed",
                message: "This org already has an active subscription; manage seats or billing from the customer portal",
              },
            },
            409,
          )
        }

        // Per-seat floor (ADR 014 §4): a subscription can never license fewer
        // seats than the org has members.
        const seats = parsed.data.seats ?? Math.max(context.member_count, 1)
        if (seats < context.member_count) {
          return c.json(
            {
              error: {
                code: "seat_count_below_members",
                message: `The org has ${context.member_count} members; license at least that many seats`,
              },
            },
            400,
          )
        }

        try {
          const session = await client.checkouts.create({
            products: [product],
            // PENDING (ADR 014 §6.3): SDK 0.48.1 has NO plain quantity
            // on checkout — `seats` (Polar seat-based pricing) is the
            // pre-decided fallback and the only per-seat lever the API offers.
            seats,
            // org-scoped customer id (stable across admins), not the
            // purchasing admin's subject.
            externalCustomerId: orgExternalCustomerId(context.org_id),
            metadata: { org_id: context.org_id },
            ...(clean(env.CLAXEDO_POLAR_CHECKOUT_SUCCESS_URL)
              ? { successUrl: clean(env.CLAXEDO_POLAR_CHECKOUT_SUCCESS_URL)! }
              : {}),
            // A person is waiting on a redirect. Without a deadline this
            // held the request open for as long as Polar took to answer, which
            // on Workers means holding the isolate too.
          }, { timeoutMs: POLAR_INTERACTIVE_TIMEOUT_MS })
          return c.json({ checkoutId: session.id, url: session.url, seats, orgId: context.org_id })
        } catch (err) {
          reportPaymentError(err, {
            tags: { source: "billing_checkout", reason: "polar_request_failed" },
            extra: { orgId: context.org_id },
          })
          return c.json(providerError(), 502)
        }
      })

      // ── Customer portal session ────────────────────────────────────────────
      .post("/portal", async (c) => {
        const authResult = await signedAuth(c)
        if ("error" in authResult) return c.json(authResult.error.body as never, authResult.error.status)
        const auth = authResult.auth
        const limit = rateLimiter.check({ userId: auth.user.subject, workspaceId: "billing" })
        if (!limit.allowed) {
          return c.json({ error: { code: "billing_rate_limited", message: "Too many billing requests" } }, 429)
        }
        const client = polar()
        if (!client) {
          reportPaymentError(new Error("Polar portal is not configured (access token)"), {
            tags: { source: "billing_portal" },
          })
          return c.json(unavailable("Billing is not configured on this control plane"), 503)
        }
        const admin = await adminContext(auth)
        if ("error" in admin) return c.json(admin.error.body as never, admin.error.status)

        try {
          // resolve the portal from the ORG-scoped customer, so a
          // non-purchasing admin reaches the same Polar customer as whoever
          // first checked out (previously this used auth.user.subject → 502 for
          // every admin but the original purchaser).
          const session = await client.customerSessions.create({
            externalCustomerId: orgExternalCustomerId(admin.context.org_id),
          }, { timeoutMs: POLAR_INTERACTIVE_TIMEOUT_MS })
          return c.json({ url: session.customerPortalUrl })
        } catch (err) {
          // Includes "no Polar customer yet" (nothing purchased): surfaced as
          // a provider error; the app should not offer the portal pre-purchase.
          reportPaymentError(err, { tags: { source: "billing_portal", reason: "polar_request_failed" } })
          return c.json(providerError(), 502)
        }
      })
  )
}
