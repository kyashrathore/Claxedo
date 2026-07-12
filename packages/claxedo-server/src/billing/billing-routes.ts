/**
 * Polar billing routes for the hosted control plane (launch plan 012 D4 +
 * ADR 014 addendum: Option B — raw `@polar-sh/sdk`, our own webhook route,
 * everything Polar confined to src/billing/**).
 *
 * Mounted by hosted-app.ts at /api/billing:
 *   POST /api/billing/polar/webhook  — Standard-Webhooks-verified state intake
 *   POST /api/billing/checkout       — Polar checkout session (admin/owner)
 *   POST /api/billing/portal         — Polar customer portal session (admin/owner)
 *
 * Customer linkage (ADR addendum): NO customer pre-creation — Polar creates
 * the customer lazily at first checkout with `external_customer_id` = the
 * verified Clerk subject; `metadata.org_id` (the Convex org doc id) rides the
 * checkout onto the subscription and is how webhook state re-attaches to the
 * org.
 *
 * Every failure path reports through reportPaymentError (D12 payment page
 * class). Fail-closed everywhere: missing secret/config → 503, bad signature
 * → 401 and the state is never applied.
 */

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
} from "../control-plane/auth"
import { createFixedWindowConnectionRateLimiter, type ConnectionRateLimiter } from "../control-plane/rate-limit"
import { reportPaymentError } from "../observability/report"
import { createBillingStore, type BillingStore, type CheckoutContext } from "./billing-store"
import { webhookEventToApplyArgs, type PolarProductConfig } from "./apply-polar-state"
import { verifyStandardWebhook, WebhookSignatureError } from "./standard-webhooks"

export type BillingEnv = Record<string, string | undefined>

/**
 * Structural slice of `@polar-sh/sdk`'s Polar client used here — tests inject
 * a fetch-stubbed instance (the SDK's HTTPClient takes a custom fetcher), or
 * any object satisfying this shape.
 */
export type PolarClientLike = {
  checkouts: {
    create(request: {
      products: string[]
      seats?: number
      externalCustomerId?: string | null
      metadata?: Record<string, string | number | boolean>
      successUrl?: string | null
    }): Promise<{ id: string; url: string }>
  }
  customerSessions: {
    create(request: { externalCustomerId: string }): Promise<{ token: string; customerPortalUrl: string }>
  }
  customers: {
    getState(request: { id: string }): Promise<unknown>
  }
}

function clean(value?: string) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function polarProductConfig(env: BillingEnv): PolarProductConfig {
  const ids = [clean(env.CLAXEDO_POLAR_PRODUCT_MONTHLY), clean(env.CLAXEDO_POLAR_PRODUCT_YEARLY)]
    .filter((id): id is string => !!id)
  return { knownProductIds: new Set(ids) }
}

/** Real SDK client from env; undefined without an access token (fail closed at routes). */
export function polarClientFromEnv(env: BillingEnv): PolarClientLike | undefined {
  const accessToken = clean(env.CLAXEDO_POLAR_ACCESS_TOKEN)
  if (!accessToken) return undefined
  return new Polar({
    accessToken,
    // Polar test mode rides the sandbox server (S2 runs there).
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
  now?: () => number
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

export function BillingRoutes(options: BillingRouteOptions) {
  const env = options.env
  const store = () => options.store ?? createBillingStore(env)
  const polar = () => options.polar ?? polarClientFromEnv(env)
  const products = polarProductConfig(env)
  // Same fixed-window pattern the workspace routes use (control-plane class):
  // checkout/portal mint external requests; keep floods off Polar and Convex.
  const rateLimiter = options.rateLimiter ?? createFixedWindowConnectionRateLimiter({ limit: 20, windowMs: 60_000 })

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
      // ── Webhook intake (D5 single-writer path) ─────────────────────────────
      .post("/polar/webhook", async (c) => {
        const secret = clean(env.CLAXEDO_POLAR_WEBHOOK_SECRET)
        if (!secret) {
          // A hosted deploy that lost the secret must be a visible outage —
          // 503 makes Polar retry (and eventually alert us), never 2xx.
          reportPaymentError(new Error("CLAXEDO_POLAR_WEBHOOK_SECRET is not configured"), {
            tags: { source: "billing_webhook" },
          })
          return c.json(unavailable("Webhook secret is not configured"), 503)
        }
        const payload = await c.req.text()
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
        const applyArgs = webhookEventToApplyArgs(event as { type?: unknown; data?: unknown }, products)
        // Not billing-state-bearing (order.*, benefit.*, unattributable
        // subscription…) → acknowledged, nothing to apply. Polar must not
        // retry these.
        if (!applyArgs) return c.json({ received: true, applied: false }, 202)

        try {
          const result = await store().applyPolarState(applyArgs)
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
            // S2-PENDING (ADR 014 §6.3 Q4): SDK 0.48.1 has NO plain quantity
            // on checkout — `seats` (Polar seat-based pricing) is the
            // pre-decided fallback and the only per-seat lever the API offers.
            seats,
            externalCustomerId: auth.user.subject,
            metadata: { org_id: context.org_id },
            ...(clean(env.CLAXEDO_POLAR_CHECKOUT_SUCCESS_URL)
              ? { successUrl: clean(env.CLAXEDO_POLAR_CHECKOUT_SUCCESS_URL)! }
              : {}),
          })
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
          const session = await client.customerSessions.create({ externalCustomerId: auth.user.subject })
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
