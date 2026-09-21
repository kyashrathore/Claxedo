/**
 * Machine-wide remote-access routes.
 *
 * `routes/hosted/workspace.ts` serves the same handshake per WORKSPACE. These
 * serve it per MACHINE, and there is no workspace id in any path here — that
 * absence is the feature. A user with twelve projects on one laptop enrolls
 * once.
 *
 * Two kinds of caller reach this file and they never share a route body:
 *
 *   Account callers (the desktop, the panel, the CLI on the owner's account)
 *     POST /requests   → a one-use nonce. Mutates no enrollment.
 *     POST /           → verify the machine's signature, record the enrollment.
 *     POST /pause, GET /, PATCH /:id/scope, PATCH /:id/display-name
 *     POST /:id/provider-config → seal the owner's provider credentials to the
 *                                 machine's declared key; the store keeps only
 *                                 the ciphertext.
 *     and, mounted beside these, the invitation routes.
 *
 *   The machine itself, once enrolled — a `claxedo connect` host with no
 *   account on the box, or the desktop's connector child after its owner
 *   enrolled it
 *     POST /redeem     → no auth: the single-use invitation secret is the credential.
 *     POST /acquire    → machine-signed: claim the next serving generation.
 *     POST /heartbeat  → machine-signed: renew, ack descriptions, discover assignments.
 *
 * An account credential buys no beat here. Enrollment is where the owner
 * speaks; everything after it is the machine speaking for itself.
 *
 * The server never holds the host key. It stores the public half and verifies;
 * `@claxedo/host-connector` holds the private half on the user's machine.
 *
 * The operation matrix names the account rows; the machine and invitation
 * routes are its "not an account operation" section — see
 * `docs/tech-docs/desktop-hosted-operation-matrix.md`.
 */

import { Hono, type Context } from "hono"
import { routeParam } from "@claxedo/helpers/route-param"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority, type MachinePrincipal, type WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { verifyMachineRequest } from "@claxedo/server-core/platform/auth/machine-auth"
import { machineSealAad, sealForMachine } from "@claxedo/server-core/platform/auth/machine-seal"
import type { HostTunnelTokenSignerInput } from "@claxedo/server-core/platform/auth/runtime-access-token"
import { serializeHostProviderConfig } from "@claxedo/server-core/credentials/host-provider-config"
import { ClaxedoError, isClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { asRecord } from "@claxedo/server-core/platform/json/index"
import { providerProjectionRecord, type ProviderProjectionSource } from "@claxedo/agent-sdk-runtime/provider-projection"
import type { ControlPlaneServices } from "../../authority/services"
import { createFixedWindowConnectionRateLimiter, type ConnectionRateLimiter } from "../../platform/auth/rate-limit"
import { requestClientKey } from "../../platform/auth/request-guard"
import { contentfulStatus } from "../../platform/http/status"
import { controlPlaneRateLimitError } from "../../workspace/runtime-token-guards"
import {
  configuredHostRelay,
  configuredHostTunnelTokenSigner,
  parsedBody,
  signedOrError,
  type WorkspaceRouteOptions,
} from "../../workspace/route-support"

const hostId = z.string().trim().min(1).max(200)
const enrollmentId = z.string().trim().min(1).max(200)
const absolutePath = z.string().min(1).max(1_024)
const scopeBody = z
  .object({
    allowed_roots: z.array(absolutePath).max(50),
    visibility: z.enum(["owner", "org"]),
  })
  .strict()

const renameBody = z.object({ displayName: z.string().trim().min(1).max(120) }).strict()

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

/**
 * Heartbeat v3, machine callers. No payload signature: the request signature
 * (`verifyMachineRequest`) already covers the whole body. `keyVersion` lets a
 * replaced key fail as a decision rather than as a signature refusal.
 */
const machineHeartbeatBody = z
  .object({
    enrollmentId,
    hostId,
    keyVersion: z.number().int().min(1).optional(),
    generation: z.number().int().min(0),
    acks: z.array(z.object({ workspaceId: z.string().min(1).max(200), revision: z.number().int().min(1) }).strict()).max(200),
    ttlMs: z.number().int().positive().optional(),
    sessionAuthority: z.enum(["local", "managed-private"]).optional(),
    sealingPublicKey: z.string().min(1).max(4_000).optional(),
    providerConfigRevision: z.number().int().min(0).optional(),
  })
  .strict()

/**
 * Rows are validated below with the runtime's own reader rather than typed
 * here, so what the control plane seals is exactly what the host will accept;
 * an empty map is the withdrawal.
 */
const providerConfigBody = z
  .object({ providers: z.record(z.string().min(1).max(200), z.record(z.string(), z.unknown())) })
  .strict()

const acquireBody = z.object({ enrollmentId, hostId, keyVersion: z.number().int().min(1).optional() }).strict()

const redeemBody = z
  .object({
    invitationId: z.string().trim().min(1).max(200),
    secret: z.string().min(1).max(200),
    hostId,
    publicKey: z.string().min(1).max(4_000),
    signature: z.string().min(1).max(4_000),
    displayName: z.string().trim().min(1).max(120).optional(),
  })
  .strict()

const invitationBody = z
  .object({
    scope: scopeBody,
    displayName: z.string().trim().min(1).max(120).optional(),
    expiresInMs: z.number().int().positive().optional(),
  })
  .strict()

const pauseBody = z.object({ hostId: hostId.optional(), paused: z.boolean() }).strict()
/** The GET route reads no body; `handle` still parses one so `run` has a typed input. */
const noBody = z.object({}).strict()

function missingBearer() {
  return { error: { code: "unauthorized", message: "Missing bearer token" } }
}

/**
 * Per-account budget for the routes that WRITE a row per call: `POST /requests`
 * and invitation creation.
 *
 * The app-wide `defaultRequestGuard` (`hosted-core-app.ts`) is IP-keyed, so a
 * signed caller behind rotating addresses — a cloud function, a proxy pool —
 * passes it while minting rows without limit. This budget is keyed on the
 * account instead.
 *
 * Sized against the human action rather than round: enrolling or inviting a
 * machine happens once per machine, and even a user setting up several
 * machines back to back, retrying a couple of times each, stays far under ten
 * a minute. A legitimate client that trips this has a bug.
 *
 * The budget also bounds `host_enrollment_requests` in steady state: with the
 * authorities' 60s challenge TTL and their prune, live unconsumed rows per
 * account can not exceed roughly limit x TTL.
 */
const DEFAULT_ENROLLMENT_REQUEST_LIMIT = 10
const DEFAULT_ENROLLMENT_REQUEST_WINDOW_MS = 60_000

/**
 * Shared per-account budget for the routes that do NOT create rows: enroll,
 * renewal (heartbeat), pause, list, scope.
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

/**
 * Per-enrollment budget for the machine-signed routes, keyed
 * `machine:<enrollment_id>` and spent only AFTER the verifier admitted the
 * caller: an unverified request must not be able to spend a real machine's
 * budget. 120/min is the same control-plane ceiling as the account beat.
 */
const DEFAULT_MACHINE_LIMIT = 120
const DEFAULT_MACHINE_WINDOW_MS = 60_000

/**
 * Per-client-address budget for the routes that admit no account, spent
 * before any body is parsed or any row is read. The hosted app's IP guard is
 * outer middleware; a self-hosted mount may not have it, so these routes
 * carry their own. Redeem is one call per machine lifetime and `/acquire`
 * one per process start; the machine heartbeat is one per lease interval,
 * and several hosts may share one egress address, so this sits at the
 * control-plane ceiling rather than at the human-action budget.
 */
const DEFAULT_CLIENT_LIMIT = 120
const DEFAULT_CLIENT_WINDOW_MS = 60_000

/** A leaked invitation id cannot be brute-forced against: 5 attempts a minute per id. */
const DEFAULT_INVITATION_REDEEM_LIMIT = 5
const DEFAULT_INVITATION_REDEEM_WINDOW_MS = 60_000

const MACHINE_BODY_LIMIT_BYTES = 16 * 1024
const REDEEM_BODY_LIMIT_BYTES = 8 * 1024
/**
 * A credential set, not a heartbeat: a placeholder can be an OAuth access
 * token of 2-4 KiB, and an owner with a dozen providers at that size needs
 * more than the machine routes' 16 KiB. Sealing is per request and the
 * ciphertext is stored, so the cap is also the row's size bound.
 */
const PROVIDER_CONFIG_BODY_LIMIT_BYTES = 32 * 1024

/** The push route's own refusals; every authority refusal already carries a code and a status. */
class HostProviderConfigError extends ClaxedoError<"invalid_provider_configuration" | "host_sealing_key_undeclared"> {}

/**
 * Decided by the runtime's own reader under the policy a host applies on
 * arrival, so the control plane never seals a set the host would refuse whole
 * and leave unacked forever. An empty map passes: it is the withdrawal.
 */
function hostReadableProviders(
  input: Record<string, Record<string, unknown>>,
): input is Record<string, ProviderProjectionSource> {
  return providerProjectionRecord(input, {}, { onInvalid: "reject" }) !== undefined
}

export type HostEnrollmentRouteOptions = WorkspaceRouteOptions & {
  /** Overridable so tests can drive the budget without issuing ten real calls. */
  enrollmentRequestRateLimiter?: ConnectionRateLimiter
  machineRateLimiter?: ConnectionRateLimiter
  clientRateLimiter?: ConnectionRateLimiter
  invitationRedeemRateLimiter?: ConnectionRateLimiter
  /** The verifier's clock; tests pin it to sign requests at a known time. */
  now?: () => number
}

type Budget = { limiter: ConnectionRateLimiter; key: string; action: string }

/** `{ error: { code, message, ...details } }` for any thrown `ClaxedoError`; everything else stays a 500. */
function claxedoErrorResponse(c: Context, err: unknown) {
  if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
  if (!isClaxedoError(err)) return undefined
  const details = asRecord(asRecord(err)?.details) ?? {}
  return c.json({ error: { code: err.code, message: err.message, ...details } }, contentfulStatus(err.status))
}

function tooLarge(limit: number) {
  return bodyLimit({
    maxSize: limit,
    onError: (c) =>
      c.json({ error: { code: "request_body_too_large", message: `Request body exceeds the ${limit}-byte limit` } }, 413),
  })
}

function budgetExceeded(c: Context, retryAfterMs: number) {
  return c.json(
    { error: { code: "control_plane_rate_limited", message: "Control Plane request limit exceeded", retryAfterMs } },
    429,
  )
}

function clientBudget(c: Context, limiter: ConnectionRateLimiter, key: string) {
  const result = limiter.check({ userId: requestClientKey(c), workspaceId: key })
  return result.allowed ? undefined : budgetExceeded(c, result.retryAfterMs)
}

/**
 * The body as JSON, read through the route's `bodyLimit` so an oversized body
 * is the middleware's 413 rather than a schema 400; unparseable text is an
 * empty object the schema then refuses.
 */
async function requestJsonThroughLimit(c: Context): Promise<unknown> {
  return parseJsonText(await c.req.text())
}

function parseJsonText(text: string): unknown {
  try {
    return text === "" ? {} : JSON.parse(text)
  } catch {
    return {}
  }
}

function unsupported(c: Context, what: string) {
  return c.json({ error: { code: "machine_caller_unsupported", message: `${what} is not supported by this authority` } }, 501)
}

function unsupportedError(what: string) {
  return new ControlPlaneAuthError(503, "workspace_authority_unavailable", `${what} is not supported by this authority`)
}

export function HostEnrollmentRoutes(services: ControlPlaneServices, options: HostEnrollmentRouteOptions) {
  const app = new Hono()
  const now = options.now ?? Date.now

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
  const machineRateLimiter =
    options.machineRateLimiter ??
    createFixedWindowConnectionRateLimiter({ limit: DEFAULT_MACHINE_LIMIT, windowMs: DEFAULT_MACHINE_WINDOW_MS })
  const clientRateLimiter =
    options.clientRateLimiter ??
    createFixedWindowConnectionRateLimiter({ limit: DEFAULT_CLIENT_LIMIT, windowMs: DEFAULT_CLIENT_WINDOW_MS })
  const invitationRedeemRateLimiter =
    options.invitationRedeemRateLimiter ??
    createFixedWindowConnectionRateLimiter({
      limit: DEFAULT_INVITATION_REDEEM_LIMIT,
      windowMs: DEFAULT_INVITATION_REDEEM_WINDOW_MS,
    })

  /**
   * Authenticate the account caller, resolve the authority, run the handler,
   * map the failures.
   *
   * One wrapper rather than the same fifteen lines in each handler: the
   * interesting part of each route below is two lines, and repeating the auth
   * dance around them is how one of them ends up missing a check.
   */
  // Generic over the SCHEMA rather than over a caller-supplied body type: the
  // body a route sees is `z.infer` of the schema it was given, so the two
  // cannot disagree.
  const handle = <Schema extends z.ZodTypeAny>(
    schema: Schema,
    run: (input: {
      body: z.infer<Schema>
      auth: SignedControlPlaneAuth
      authority: WorkspaceAuthority
      c: Context
    }) => Promise<Record<string, unknown>>,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    budget: Budget,
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
      if ("error" in authResult) return c.json(authResult.error, authResult.status)
      const auth = authResult.auth
      // Type narrowing, not a second check: `requireSigned: true` above means
      // an unsigned request already returned 401 from `signedOrError`.
      if (!auth) return c.json(missingBearer(), 401)

      // Keyed on the verified account (`controlPlaneRateLimitError` reads
      // `auth.user.subject`), so it is spent BEFORE the body is read and long
      // before any authority round-trip or signature verification — a flood
      // must be rejected while rejecting it is still cheap.
      const limited = await controlPlaneRateLimitError(services, budget.limiter, auth, {
        key: budget.key,
        action: budget.action,
      })
      if (limited) return c.json(limited.body, limited.status)

      const parsed = method === "GET" || method === "DELETE"
        ? parsedBody(schema, {})
        : parsedBody(schema, await requestJsonThroughLimit(c))
      if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)

      try {
        return c.json(await run({ body: parsed.body, auth, authority: requireAuthority(services), c }))
      } catch (err) {
        return claxedoErrorResponse(c, err) ?? Promise.reject(err)
      }
    }

  /**
   * The machine caller's path, in the P1.1 order: body cap (route middleware,
   * applied before this runs) → client-address budget → the verifier over the
   * exact body text → per-enrollment budget → schema → authority.
   */
  const machine = <Schema extends z.ZodTypeAny>(
    schema: Schema,
    run: (input: {
      body: z.infer<Schema>
      machine: MachinePrincipal
      authority: WorkspaceAuthority
      c: Context
    }) => Promise<Record<string, unknown>>,
    key: string,
  ) =>
    async (c: Context) => {
      const limited = clientBudget(c, clientRateLimiter, `client:${key}`)
      if (limited) return limited
      const authority = requireAuthority(services)
      if (!authority.machineAuth) return unsupported(c, "Machine-signed enrollment")
      const bodyText = await c.req.text()
      const verified = await verifyMachineRequest(
        { method: c.req.method, pathname: new URL(c.req.url).pathname, headers: c.req.raw.headers, bodyText },
        { ...authority.machineAuth, now },
      )
      if (!verified.ok) {
        return c.json({ error: { code: verified.code, message: "Machine request refused" } }, verified.status)
      }
      const perEnrollment = machineRateLimiter.check({
        userId: `machine:${verified.machine.enrollmentId}`,
        workspaceId: key,
      })
      if (!perEnrollment.allowed) return budgetExceeded(c, perEnrollment.retryAfterMs)
      const parsed = parsedBody(schema, parseJsonText(bodyText))
      if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)
      try {
        return c.json(await run({ body: parsed.body, machine: verified.machine, authority, c }))
      } catch (err) {
        return claxedoErrorResponse(c, err) ?? Promise.reject(err)
      }
    }

  const hostEndpoints = () => {
    const relay = configuredHostRelay(options)
    return {
      ...(relay ? { relay } : {}),
      ...(options.sessionAuthorityUrl ? { authority: { session_authority_url: options.sessionAuthorityUrl } } : {}),
    }
  }

  const machineHeartbeat = machine(machineHeartbeatBody, async ({ body, machine: caller, authority }) => {
    if (!authority.heartbeatHostEnrollmentByMachine) throw unsupportedError("Machine heartbeat")
    const result = await authority.heartbeatHostEnrollmentByMachine(caller, {
      enrollmentId: body.enrollmentId,
      hostId: body.hostId,
      generation: body.generation,
      acks: body.acks,
      ...(body.ttlMs === undefined ? {} : { ttlMs: body.ttlMs }),
      ...(body.sessionAuthority ? { sessionAuthority: body.sessionAuthority } : {}),
      ...(body.sealingPublicKey ? { sealingPublicKey: body.sealingPublicKey } : {}),
      ...(body.providerConfigRevision === undefined ? {} : { providerConfigAckedRevision: body.providerConfigRevision }),
    })
    // Exactly the set the batch just made ready: an ack at the assignment's
    // current revision. A stale ack renews the lease but earns no credential
    // for that workspace, the same answer every other routability reader gives.
    const current = new Map(result.assignments.map((assignment) => [assignment.workspace_id, assignment.revision]))
    const ready = body.acks
      .filter((ack) => current.get(ack.workspaceId) === ack.revision)
      .map((ack) => ack.workspaceId)
      .sort()
    const endpoints = hostEndpoints()
    const response: Record<string, unknown> = { ...result, ...endpoints, serving_generation: caller.generation }
    const signer = configuredHostTunnelTokenSigner(options)
    if (!signer || ready.length === 0) return response
    const input: HostTunnelTokenSignerInput & { enrollmentId: string; generation: number } = {
      subject: caller.ownerUserId,
      hostId: caller.hostId,
      workspaceIds: ready,
      enrollmentId: caller.enrollmentId,
      generation: caller.generation,
    }
    const credential = await signer(input)
    return {
      ...response,
      hostTunnel: {
        ...credential,
        hostId: caller.hostId,
        // Restates the token's own `enrollment_id` claim. The process that
        // declares this machine's identity to its local clients is the daemon
        // holding the credential, and the credential is all of the enrollment
        // it ever receives.
        enrollmentId: caller.enrollmentId,
        workspaceIds: ready,
        ...(endpoints.relay ? { relayUrl: endpoints.relay.url } : {}),
      },
    }
  }, "host.enrollments.heartbeat")

  return app
    .post(
      "/requests",
      handle(requestBody, async ({ body, auth, authority }) => {
        await authority.usersMe(auth)
        return authority.createHostEnrollmentRequest(auth, { hostId: body.hostId })
      }, "POST", {
        limiter: enrollmentRequestRateLimiter,
        key: "host.enrollments.requests",
        action: "host_enrollment.request.denied",
      }),
    )
    .post(
      "/",
      handle(enrollBody, async ({ body, auth, authority }) => {
        await authority.usersMe(auth)
        // The connector signed the nonce with its own private key. This server
        // only records the enrollment — it never holds the host key, and
        // nothing is written until the authority verifies the signature.
        const enrollment = await authority.enrollHost(auth, {
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
    .post("/heartbeat", tooLarge(MACHINE_BODY_LIMIT_BYTES), machineHeartbeat)
    .post("/acquire", tooLarge(MACHINE_BODY_LIMIT_BYTES), machine(acquireBody, async ({ machine: caller, authority }) => {
      if (!authority.acquireHostServingGeneration) throw unsupportedError("Serving generation acquisition")
      const result = await authority.acquireHostServingGeneration(caller)
      return { generation: result.generation, generation_acquired_at: result.generation_acquired_at }
    }, "host.enrollments.acquire"))
    .post("/redeem", tooLarge(REDEEM_BODY_LIMIT_BYTES), async (c) => {
      const limited = clientBudget(c, clientRateLimiter, "client:host.enrollments.redeem")
      if (limited) return limited
      const authority = requireAuthority(services)
      if (!authority.redeemHostInvitation) return unsupported(c, "Invitation redemption")
      const parsed = parsedBody(redeemBody, await requestJsonThroughLimit(c))
      if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)
      const body = parsed.body
      const perInvitation = invitationRedeemRateLimiter.check({
        userId: `invitation:${body.invitationId}`,
        workspaceId: "host.enrollments.redeem",
      })
      if (!perInvitation.allowed) return budgetExceeded(c, perInvitation.retryAfterMs)
      try {
        const result = await authority.redeemHostInvitation({
          invitationId: body.invitationId,
          secret: body.secret,
          hostId: body.hostId,
          publicKey: body.publicKey,
          signature: body.signature,
          ...(body.displayName ? { displayName: body.displayName } : {}),
        })
        return c.json({ ...result, ...hostEndpoints() })
      } catch (err) {
        return claxedoErrorResponse(c, err) ?? Promise.reject(err)
      }
    })
    .post(
      "/pause",
      handle(pauseBody, async ({ body, auth, authority }) => {
        const result = await authority.pauseHostEnrollment(auth, {
          ...(body.hostId ? { hostId: body.hostId } : {}),
          paused: body.paused,
        })
        await authority.auditAllow(auth, {
          action: body.paused ? "host_enrollment.paused" : "host_enrollment.resumed",
          metadata: (body.hostId ? { hostId: body.hostId } : {}),
        })
        return result
      }, "POST", {
        limiter: controlPlaneRateLimiter,
        key: "host.enrollments.pause",
        action: "host_enrollment.pause.denied",
      }),
    )
    .patch(
      "/:id/scope",
      handle(scopeBody, async ({ body, auth, authority, c }) => {
        if (!authority.updateHostEnrollmentScope) throw unsupportedError("Enrollment scope")
        return await authority.updateHostEnrollmentScope(auth, {
          enrollmentId: routeParam(c, "id"),
          scope: { allowed_roots: body.allowed_roots, visibility: body.visibility },
        })
      }, "PATCH", {
        limiter: controlPlaneRateLimiter,
        key: "host.enrollments.scope",
        action: "host_enrollment.scope.denied",
      }),
    )
    .patch(
      "/:id/display-name",
      handle(renameBody, async ({ body, auth, authority, c }) => {
        if (!authority.renameHostEnrollment) throw unsupportedError("Enrollment rename")
        return await authority.renameHostEnrollment(auth, {
          enrollmentId: routeParam(c, "id"),
          displayName: body.displayName,
        })
      }, "PATCH", {
        limiter: controlPlaneRateLimiter,
        key: "host.enrollments.rename",
        action: "host_enrollment.rename.denied",
      }),
    )
    .post(
      "/:id/provider-config",
      tooLarge(PROVIDER_CONFIG_BODY_LIMIT_BYTES),
      handle(providerConfigBody, async ({ body, auth, authority, c }) => {
        if (!authority.hostProviderConfigTarget || !authority.pushHostProviderConfig) {
          throw unsupportedError("Host provider configuration")
        }
        if (!hostReadableProviders(body.providers)) {
          throw new HostProviderConfigError({
            code: "invalid_provider_configuration",
            status: 400,
            message: "providers names a row the host could not read",
          })
        }
        const providers = body.providers
        const providerIds = Object.keys(providers).sort()
        const target = await authority.hostProviderConfigTarget(auth, { enrollmentId: routeParam(c, "id") })
        if (target.sealing_public_key === null) {
          throw new HostProviderConfigError({
            code: "host_sealing_key_undeclared",
            status: 409,
            message: "The machine has not declared a sealing key; it declares one on its next heartbeat",
          })
        }
        const enrollmentId = target.enrollment_id
        const revision = target.next_revision
        // The plaintext exists only as this argument. The store receives the
        // ciphertext and the audit the provider ids; nothing below reads
        // `providers` again.
        const sealed = providerIds.length === 0
          ? null
          : await sealForMachine(
            target.sealing_public_key,
            serializeHostProviderConfig(providers),
            machineSealAad({ enrollmentId, revision }),
          )
        const result = await authority.pushHostProviderConfig(auth, {
          enrollmentId,
          sealed,
          revision,
          sealingPublicKey: target.sealing_public_key,
          providerIds,
        })
        await authority.auditAllow(auth, {
          action: "host_provider_config.pushed",
          metadata: { enrollmentId, revision: result.revision, providerIds },
        })
        return { enrollment_id: result.enrollment_id, revision: result.revision, sealed: result.sealed }
      }, "POST", {
        limiter: controlPlaneRateLimiter,
        key: "host.enrollments.provider-config",
        action: "host_provider_config.push.denied",
      }),
    )
    .get(
      "/",
      handle(noBody, async ({ auth, authority }) => ({
        ...(await authority.activeHostEnrollment(auth)),
        ...(authority.listHostEnrollments ? { machines: await authority.listHostEnrollments(auth) } : {}),
      }), "GET", {
        limiter: controlPlaneRateLimiter,
        key: "host.enrollments.active",
        action: "host_enrollment.active.denied",
      }),
    )
}

/**
 * The owner's invitations, mounted beside the enrollment routes at
 * `/api/claxedo/host/invitations`. Creating one mints the secret this
 * response is the only place to read; the store keeps its hash.
 */
export function HostInvitationRoutes(services: ControlPlaneServices, options: HostEnrollmentRouteOptions) {
  const app = new Hono()
  const createRateLimiter =
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

  const handle = <Schema extends z.ZodTypeAny>(
    schema: Schema,
    run: (input: {
      body: z.infer<Schema>
      auth: SignedControlPlaneAuth
      authority: WorkspaceAuthority
      c: Context
    }) => Promise<Record<string, unknown>>,
    method: "GET" | "POST" | "DELETE",
    budget: Budget,
  ) =>
    async (c: Context) => {
      const authResult = await signedOrError(c.req.raw, { ...options, requireSigned: true as const }, services)
      if ("error" in authResult) return c.json(authResult.error, authResult.status)
      const auth = authResult.auth
      if (!auth) return c.json(missingBearer(), 401)
      const limited = await controlPlaneRateLimitError(services, budget.limiter, auth, {
        key: budget.key,
        action: budget.action,
      })
      if (limited) return c.json(limited.body, limited.status)
      const parsed = method === "POST" ? parsedBody(schema, await requestJsonThroughLimit(c)) : parsedBody(schema, {})
      if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)
      try {
        return c.json(await run({ body: parsed.body, auth, authority: requireAuthority(services), c }))
      } catch (err) {
        return claxedoErrorResponse(c, err) ?? Promise.reject(err)
      }
    }

  return app
    .post(
      "/",
      handle(invitationBody, async ({ body, auth, authority }) => {
        if (!authority.createHostInvitation) throw unsupportedError("Host invitations")
        await authority.usersMe(auth)
        const created = await authority.createHostInvitation(auth, {
          scope: { allowed_roots: body.scope.allowed_roots, visibility: body.scope.visibility },
          ...(body.displayName ? { displayName: body.displayName } : {}),
          ...(body.expiresInMs === undefined ? {} : { expiresInMs: body.expiresInMs }),
        })
        await authority.auditAllow(auth, {
          action: "host_invitation.created",
          metadata: { invitationId: created.invitationId, expiresAt: created.expiresAt },
        })
        return { invitation_id: created.invitationId, token: created.token, expires_at: created.expiresAt }
      }, "POST", {
        limiter: createRateLimiter,
        key: "host.invitations.create",
        action: "host_invitation.create.denied",
      }),
    )
    .get(
      "/",
      handle(noBody, async ({ auth, authority }) => {
        if (!authority.listHostInvitations) throw unsupportedError("Host invitations")
        return { invitations: await authority.listHostInvitations(auth) }
      }, "GET", {
        limiter: controlPlaneRateLimiter,
        key: "host.invitations.list",
        action: "host_invitation.list.denied",
      }),
    )
    .delete(
      "/:id",
      handle(noBody, async ({ auth, authority, c }) => {
        if (!authority.revokeHostInvitation) throw unsupportedError("Host invitations")
        const invitationId = routeParam(c, "id")
        const result = await authority.revokeHostInvitation(auth, { invitationId })
        if (result.revoked) {
          await authority.auditAllow(auth, { action: "host_invitation.revoked", metadata: { invitationId } })
        }
        return result
      }, "DELETE", {
        limiter: controlPlaneRateLimiter,
        key: "host.invitations.revoke",
        action: "host_invitation.revoke.denied",
      }),
    )
}
