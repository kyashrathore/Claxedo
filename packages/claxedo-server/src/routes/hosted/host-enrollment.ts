/**
 * Machine-wide remote-access routes.
 *
 * `routes/hosted/workspace.ts` serves the same handshake per WORKSPACE. These
 * serve it per MACHINE, and there is no `:id` in any path here — that absence
 * is the feature. A user with twelve projects on one laptop enrolls once.
 *
 * The flow, unchanged in shape from the per-workspace one because the security
 * property is the same:
 *
 *   1. POST /requests   → a one-use nonce. Mutates no enrollment.
 *   2. Host Connector signs (hostId, requestId, nonce) with its machine key.
 *   3. POST /           → verify the signature, record the enrollment.
 *   4. POST /heartbeat  → client-signed; extend.
 *   5. POST /pause      → pause one machine, or every machine this owner has.
 *   6. GET  /           → what the settings screen shows.
 *
 * The server never holds the host key. It stores the public half and verifies;
 * `@claxedo/host-connector` holds the private half on the user's machine.
 *
 * The operation matrix names step 3 `host.enrollCurrentMachine`. Nothing here
 * is reachable through a generic proxy — see
 * `docs/tech-docs/desktop-hosted-operation-matrix.md`.
 */

import { Hono, type Context } from "hono"
import { z } from "zod"
import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneServices } from "../../authority/services"
import { createFixedWindowConnectionRateLimiter, type ConnectionRateLimiter } from "../../platform/auth/rate-limit"
import { controlPlaneRateLimitError } from "../../workspace/runtime-token-guards"
import {
  configuredHostTunnelTokenSigner,
  configuredRelayUrl,
  parsedBody,
  signedOrError,
  type WorkspaceRouteOptions,
} from "../../workspace/route-support"

const hostId = z.string().trim().min(1).max(200)

const requestBody = z.object({ hostId }).strict()

const enrollBody = z
  .object({
    hostId,
    publicKey: z.string().min(1).max(4_000),
    requestId: z.string().min(1).max(200),
    signature: z.string().min(1).max(4_000),
    displayName: z.string().trim().min(1).max(120).optional(),
    ttlMs: z.number().int().positive().optional(),
  })
  .strict()

const heartbeatBody = z
  .object({
    hostId,
    signature: z.string().min(1).max(4_000),
    ttlMs: z.number().int().positive().optional(),
    // The served set the signature covers (heartbeat payload v2): one
    // signature per interval carries the machine's whole consent set.
    workspaceIds: z.array(z.string().min(1).max(200)).max(200),
  })
  .strict()

const pauseBody = z.object({ hostId: hostId.optional(), paused: z.boolean() }).strict()

function missingBearer() {
  return { error: { code: "unauthorized", message: "Missing bearer token" } }
}

/**
 * The authority may not implement enrollment yet.
 *
 * The port's methods are optional while both authorities are being built out.
 * A 501 that says so beats a `TypeError: not a function` reaching the client as
 * a 500, and it disappears when Unit 6's hard cut makes the methods required.
 */
function unsupported() {
  return { error: { code: "not_implemented", message: "This control plane does not support machine enrollment" } }
}

class EnrollmentUnsupported extends Error {}

/**
 * Per-account budget for `POST /requests`, the one route here that WRITES a row
 * per call.
 *
 * Not covered by the app-wide `defaultRequestGuard` in
 * `deployments/hosted-shared/hosted-app.ts`, and the difference is the point:
 * that guard is IP-keyed by design, so it bounds one network path and says
 * nothing about one ACCOUNT. A signed caller behind rotating addresses — a
 * cloud function, a residential proxy pool — passes it while minting enrollment
 * requests without limit; the plan's Unit 6 abuse-control bullet asks for
 * per-account, per-host and per-peer limits for exactly that reason.
 *
 * Sized against the human action rather than round: enrolling a machine happens
 * once per machine, and even a user setting up several laptops back to back,
 * retrying a couple of times each, stays far under ten a minute. A legitimate
 * client that trips this has a bug.
 *
 * The budget also bounds `host_enrollment_requests` in steady state: with the
 * authorities' 60s challenge TTL and their prune, live unconsumed rows per
 * account can not exceed roughly limit x TTL.
 */
const DEFAULT_ENROLLMENT_REQUEST_LIMIT = 10
const DEFAULT_ENROLLMENT_REQUEST_WINDOW_MS = 60_000

/**
 * Shared per-account budget for the routes that do NOT create rows: enroll,
 * renewal (heartbeat), pause, list.
 *
 * Its own ceiling rather than a slice of the one above, the same split
 * `routes/hosted/workspace.ts` makes between `createWorkspaceRateLimiter` and
 * `controlPlaneRateLimiter`: a heartbeat storm must not consume the budget that
 * lets a user enroll a new machine, and a create flood must not hide inside the
 * traffic every enrolled connector generates. 120/min matches that file's
 * control-plane budget and sits well above any honest connector, which
 * heartbeats on the order of once per TTL.
 */
const DEFAULT_ENROLLMENT_CONTROL_PLANE_LIMIT = 120
const DEFAULT_ENROLLMENT_CONTROL_PLANE_WINDOW_MS = 60_000

export type HostEnrollmentRouteOptions = WorkspaceRouteOptions & {
  /** Overridable so tests can drive the budget without issuing ten real calls. */
  enrollmentRequestRateLimiter?: ConnectionRateLimiter
}

export function HostEnrollmentRoutes(services: ControlPlaneServices, options: HostEnrollmentRouteOptions) {
  const app = new Hono()

  const enrollmentRequestRateLimiter =
    options.enrollmentRequestRateLimiter ??
    createFixedWindowConnectionRateLimiter({
      limit: DEFAULT_ENROLLMENT_REQUEST_LIMIT,
      windowMs: DEFAULT_ENROLLMENT_REQUEST_WINDOW_MS,
    })
  const controlPlaneRateLimiter =
    options.controlPlaneRateLimiter ??
    createFixedWindowConnectionRateLimiter({
      limit: DEFAULT_ENROLLMENT_CONTROL_PLANE_LIMIT,
      windowMs: DEFAULT_ENROLLMENT_CONTROL_PLANE_WINDOW_MS,
    })

  /**
   * Authenticate, resolve the authority, run the handler, map the failures.
   *
   * One wrapper rather than the same fifteen lines in each of five handlers:
   * the interesting part of each route below is two lines, and repeating the
   * auth dance around them is how one of them ends up missing a check.
   */
  const handle = <Body>(
    schema: { safeParse: (input: unknown) => unknown },
    run: (input: {
      body: Body
      auth: SignedControlPlaneAuth
      authority: ReturnType<typeof requireAuthority>
    }) => Promise<unknown>,
    method: "GET" | "POST",
    budget: { limiter: ConnectionRateLimiter; key: string; action: string },
  ) =>
    async (c: Context) => {
      const authResult = await signedOrError(
        c.req.raw,
        // Signed only. There is no unsigned path to machine enrollment: a
        // loopback caller with no account has no account to enroll a machine
        // against.
        { ...options, requireSigned: true as const },
        services,
      )
      if ("error" in authResult) return c.json(authResult.error, authResult.status as 401 | 403 | 503)
      const auth = authResult.auth
      // Type narrowing, not a second check: `requireSigned: true` above means
      // an unsigned request already returned 401 from `signedOrError`. Removing
      // this line fails no test, because nothing can reach it.
      if (!auth) return c.json(missingBearer(), 401)

      // Keyed on the verified account (`controlPlaneRateLimitError` reads
      // `auth.user.subject`), so it is spent BEFORE the body is read and long
      // before any authority round-trip or signature verification — a flood
      // must be rejected while rejecting it is still cheap. It is deliberately
      // NOT an argument to this call: there is exactly one correct value for
      // it, and making it a parameter would only create the chance to omit it.
      //
      // Every route takes a budget, so adding one here cannot be forgotten the
      // way it was when this file had none.
      const limited = await controlPlaneRateLimitError(services, budget.limiter, auth, {
        key: budget.key,
        action: budget.action,
      })
      if (limited) return c.json(limited.body, limited.status)

      const parsed = method === "GET"
        ? ({ ok: true, body: {} as Body } as const)
        : parsedBody(schema as never, await c.req.json().catch(() => ({})))
      if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)

      try {
        return c.json((await run({ body: parsed.body as Body, auth, authority: requireAuthority(services) })) as never)
      } catch (err) {
        if (err instanceof EnrollmentUnsupported) return c.json(unsupported(), 501)
        if (err instanceof ControlPlaneAuthError) {
          return c.json(controlPlaneAuthErrorBody(err), err.status as 400 | 401 | 403 | 503)
        }
        throw err
      }
    }

  /** Present or 501 — the port's methods are optional until the hard cut. */
  function required<T>(method: T | undefined): NonNullable<T> {
    if (!method) throw new EnrollmentUnsupported()
    return method as NonNullable<T>
  }

  return app
    .post(
      "/requests",
      handle<z.infer<typeof requestBody>>(requestBody, async ({ body, auth, authority }) => {
        const create = required(authority.createHostEnrollmentRequest)
        await authority.usersMe(auth)
        return create(auth, { hostId: body.hostId })
      }, "POST", {
        limiter: enrollmentRequestRateLimiter,
        key: "host.enrollments.requests",
        action: "host_enrollment.request.denied",
      }),
    )
    .post(
      "/",
      handle<z.infer<typeof enrollBody>>(enrollBody, async ({ body, auth, authority }) => {
        const enroll = required(authority.enrollHost)
        await authority.usersMe(auth)
        // The connector signed the nonce with its own private key. This server
        // only records the enrollment — it never holds the host key, and
        // nothing is written until the authority verifies the signature.
        const enrollment = await enroll(auth, {
          hostId: body.hostId,
          publicKey: body.publicKey,
          requestId: body.requestId,
          signature: body.signature,
          ...(body.displayName ? { displayName: body.displayName } : {}),
          ...(body.ttlMs === undefined ? {} : { ttlMs: body.ttlMs }),
        })
        await authority.auditAllow(auth, { action: "host_enrollment.enabled", metadata: { hostId: body.hostId } })
        return { enrollment }
      }, "POST", {
        limiter: controlPlaneRateLimiter,
        key: "host.enrollments.enroll",
        action: "host_enrollment.enroll.denied",
      }),
    )
    .post(
      "/heartbeat",
      handle<z.infer<typeof heartbeatBody>>(heartbeatBody, async ({ body, auth, authority }) => {
        const beat = required(authority.heartbeatHostEnrollment)
        const result = await beat(auth, {
          hostId: body.hostId,
          signature: body.signature,
          workspaceIds: body.workspaceIds,
          ...(body.ttlMs === undefined ? {} : { ttlMs: body.ttlMs }),
        })
        // The serving credential rides the ack: ONE Host Tunnel Token whose
        // workspace_ids claim is exactly the set that is BOTH owner-assigned
        // and covered by the signature this beat just verified. The machine
        // (re)opens or re-registers its single relay connection from the same
        // response that renewed its lease. Local workspaces have no home
        // region of their own; the deployment default names the relay.
        const assigned = new Set(result.assigned_workspace_ids ?? [])
        const serveable = body.workspaceIds.filter((workspaceId) => assigned.has(workspaceId)).sort()
        const signer = configuredHostTunnelTokenSigner(options)
        const relayUrl = configuredRelayUrl(options)
        if (!signer || serveable.length === 0) return result
        const credential = await signer({
          subject: auth.user.subject,
          hostId: body.hostId,
          workspaceIds: serveable,
        })
        return {
          ...result,
          hostTunnel: {
            ...credential,
            hostId: body.hostId,
            workspaceIds: serveable,
            ...(relayUrl ? { relayUrl } : {}),
          },
        }
      }, "POST", {
        limiter: controlPlaneRateLimiter,
        key: "host.enrollments.heartbeat",
        action: "host_enrollment.heartbeat.denied",
      }),
    )
    .post(
      "/pause",
      handle<z.infer<typeof pauseBody>>(pauseBody, async ({ body, auth, authority }) => {
        const pause = required(authority.pauseHostEnrollment)
        const result = await pause(auth, {
          ...(body.hostId ? { hostId: body.hostId } : {}),
          paused: body.paused,
        })
        await authority.auditAllow(auth, {
          action: body.paused ? "host_enrollment.paused" : "host_enrollment.resumed",
          metadata: { ...(body.hostId ? { hostId: body.hostId } : {}) },
        })
        return result
      }, "POST", {
        limiter: controlPlaneRateLimiter,
        key: "host.enrollments.pause",
        action: "host_enrollment.pause.denied",
      }),
    )
    .get(
      "/",
      handle<Record<string, never>>(pauseBody, async ({ auth, authority }) => required(authority.activeHostEnrollment)(auth), "GET", {
        limiter: controlPlaneRateLimiter,
        key: "host.enrollments.active",
        action: "host_enrollment.active.denied",
      }),
    )
}
