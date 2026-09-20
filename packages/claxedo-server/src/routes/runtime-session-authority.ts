import { randomUUID } from "node:crypto"
import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import {
  createRemoteJWKSet,
  importJWK,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
  type JWTVerifyGetKey,
} from "jose"
import { bearerToken, ControlPlaneAuthError, controlPlaneAuthErrorBody } from "@claxedo/server-core/platform/auth/auth"
import { asRecord } from "@claxedo/helpers/guards"
import {
  privateSessionRuntimeProof,
  type PrivateSessionAuthority,
  type PrivateSessionRuntimePrincipal,
  type RelayHostPrivateSessionClaims,
} from "@claxedo/server-core/platform/auth/private-session-authority"
import {
  SessionTurnConflictError,
  SessionTurnLeaseLostError,
  type SessionTurnAuthority,
} from "@claxedo/server-core/platform/auth/session-turn-authority"
import { SESSION_STREAM_LEASE_TTL_MS } from "@claxedo/workspace-relay-protocol"
import { readJsonRecord } from "@claxedo/server-core/platform/json/index"
import type { WorkspaceOwnerIdentity } from "@claxedo/server-core/platform/auth/authority"
import type { SessionWriteClass } from "@claxedo/server-core/platform/auth/private-session-authority"
import { trimToUndefined } from "@claxedo/helpers/string"

const bodyLimitBytes = 16 * 1024
const streamLeaseIssuer = "claxedo-control-plane"
const streamLeaseAudience = "workspace-runtime-session-stream"
const turnLeaseIssuer = "claxedo-control-plane"
const turnLeaseAudience = "workspace-runtime-session-turn"

type RuntimeSessionAuthorityPort = Pick<
  PrivateSessionAuthority,
  | "registerRuntimeSession"
  | "markSessionRegistrationAmbiguous"
  | "beginSessionCompensation"
  | "completeSessionCompensation"
  | "authorizeRuntimeSession"
> & {
  runtimeAccessTokenActive: (input: {
    jti: string
    workspaceId: string
    hostId: string
    minimumRole?: "viewer" | "editor" | "admin" | "owner"
  }) => Promise<unknown>
  /** Absent on a plane that cannot reserve for a runtime actor; the owner grant's `reserve` then answers 503. */
  reserveRuntimeSession?: PrivateSessionAuthority["reserveRuntimeSession"]
  /** Absent on a plane that records no host enrollments; `adopt` then answers 503. */
  adoptRuntimeSession?: PrivateSessionAuthority["adoptRuntimeSession"]
}

/** The workspace's owner as the authority records them now, or nothing for a workspace that has none. */
export type ResolveWorkspaceOwner = (workspaceId: string) => Promise<WorkspaceOwnerIdentity | undefined>

/**
 * How a plane that mints owner grants recognises and verifies one. Supplied
 * by the composition that mints them; a plane without it accepts none, and
 * carries none of the pass family in its closure.
 */
export type OwnerGrantProof = {
  /** Whether a bearer names the owner-grant audience, read without verifying: which verifier to run, not whether to trust it. */
  names(token: string): boolean
  /** The grant's scope; rejects a bearer that does not verify, is expired, or was revoked. */
  verify(token: string): Promise<{ userId: string; actorId: string; orgId: string; workspaceId: string }>
  resolveWorkspaceOwner: ResolveWorkspaceOwner
}

/**
 * How the runtime holding a lease proved its identity, and therefore what a
 * renewal re-checks. A relay host presents a Relay Host Token minted from a
 * durable Runtime Access Token, so every renewal re-checks that parent token
 * is still active. A workspace's own runtime presents the owner grant the
 * control plane launched it with, so every renewal re-resolves the
 * workspace's owner and refuses once the grant's actor is not that owner. An
 * embedded runtime runs inside the control plane process that mints the lease
 * and has no token chain of its own.
 */
export type SessionStreamLeaseBinding =
  | { transport: "relay-host"; hostId: string; parentRuntimeAccessTokenJti: string }
  | { transport: "owner-grant" }
  | { transport: "embedded" }

export type SessionStreamLeaseClaims = PrivateSessionRuntimePrincipal & SessionStreamLeaseBinding & {
  orgId: string
  workspaceId: string
  /**
   * The session the lease is bound to, or `"*"`: a WORKSPACE stream lease,
   * minted by `host_read` for the runtime's unscoped `wr/events` arm, which
   * proves the reader's identity for every session that first appears on a
   * connection that outlives its one-request relay host token. It proves who
   * the reader is, never what they may read: each session is still authorized
   * on its own when the lease is presented for it.
   */
  sessionId: string
  action: "read" | "write"
}

export const WORKSPACE_STREAM_LEASE_SESSION = "*"

/** Prompt admission is reached over a proof a runtime presents, never from inside the plane's own process. */
type TurnLeaseClaims = Extract<SessionStreamLeaseClaims, { transport: "relay-host" | "owner-grant" }> & {
  turnId: string
  authorityLeaseId: string
  fencingToken: number
  acquiredAt: number
  expiresAt: number
}

export type RuntimeSessionStreamDecision =
  | { allowed: true; lease: string; expiresAt: number }
  | { allowed: false; status: 401; code: string; message: string }

export type RuntimeSessionStreamOptions = {
  authority: Pick<RuntimeSessionAuthorityPort, "authorizeRuntimeSession" | "runtimeAccessTokenActive">
  /** Absent on a plane that mints no owner grants; a lease bound to one is then refused at renewal. */
  resolveWorkspaceOwner?: ResolveWorkspaceOwner
  mintStreamLease?: (claims: SessionStreamLeaseClaims) => Promise<{ lease: string; expiresAt: number }>
  env?: Record<string, string | undefined>
}

/**
 * The one owner of "may this principal keep a live stream on this session,
 * and what proof carries it until the next renewal".
 *
 * `RuntimeSessionAuthorityRoutes` serves it over HTTP to isolated runtimes;
 * the self-hosted composition calls it in process for its embedded runtime.
 * Both re-run it on every renewal, so a revoked participant or a revoked
 * parent token ends the stream at the next refresh. A denial from the
 * private-session authority itself surfaces as the `ControlPlaneAuthError`
 * that authority throws.
 */
export async function authorizeRuntimeSessionStream(
  options: RuntimeSessionStreamOptions,
  claims: SessionStreamLeaseClaims,
  /** A bearer verified on this same request was already rechecked; a lease carries no bearer and is rechecked here. */
  proof: { rechecked: boolean } = { rechecked: false },
): Promise<RuntimeSessionStreamDecision> {
  const denial = proof.rechecked ? undefined : await proofDenial(options, claims)
  if (denial) return { allowed: false, status: 401, ...denial }
  await options.authority.authorizeRuntimeSession({
    ...sessionLeasePrincipal(claims),
    sessionId: claims.sessionId,
    workspaceId: claims.workspaceId,
    action: claims.action,
  })
  const minter = options.mintStreamLease ?? streamLeaseMinter(options.env ?? process.env)
  return { allowed: true, ...await minter(claims) }
}

/** Verifies a lease this control plane minted and returns its bound claims. */
export function sessionStreamLeaseVerifier(env: Record<string, string | undefined> = process.env) {
  return streamLeaseVerifier(env)
}

function sessionLeasePrincipal(claims: SessionStreamLeaseClaims): PrivateSessionRuntimePrincipal {
  return claims.principalKind === "user"
    ? { principalKind: "user", actorId: claims.actorId, actorKind: "human" }
    : { principalKind: "service", actorId: claims.actorId, actorKind: "agent" }
}

async function runtimeAccessTokenDenial(
  authority: Pick<RuntimeSessionAuthorityPort, "runtimeAccessTokenActive">,
  claims: SessionStreamLeaseClaims,
) {
  if (claims.transport !== "relay-host") return undefined
  const active = asRecord(await authority.runtimeAccessTokenActive({
    jti: claims.parentRuntimeAccessTokenJti,
    workspaceId: claims.workspaceId,
    hostId: claims.hostId,
  }))
  if (active?.active === true) return undefined
  return {
    code: trimToUndefined(active?.code) ?? "runtime_access_token_inactive",
    message: trimToUndefined(active?.reason) ?? "Runtime Access Token is inactive",
  }
}

const OWNER_GRANT_INVALID = { code: "owner_grant_invalid", message: "Owner grant is invalid, expired, or no longer names this workspace's owner" }

/**
 * The owner grant's recheck, on every call: the grant names an actor, the
 * authority names the workspace's owner now, and they have to be the same
 * person in the same organization. Done for a bearer and for every lease
 * minted from one, since a re-owned workspace ends both at the next call.
 */
async function ownerGrantDenial(
  resolveWorkspaceOwner: ResolveWorkspaceOwner | undefined,
  named: { actorId: string; orgId: string; workspaceId: string; userId?: string },
) {
  const owner = resolveWorkspaceOwner ? await resolveWorkspaceOwner(named.workspaceId).catch(() => undefined) : undefined
  if (!owner || owner.actorId !== named.actorId || owner.orgId !== named.orgId || (named.userId !== undefined && owner.userId !== named.userId)) {
    return OWNER_GRANT_INVALID
  }
  return undefined
}

async function proofDenial(
  options: Pick<RuntimeSessionStreamOptions, "authority" | "resolveWorkspaceOwner">,
  claims: SessionStreamLeaseClaims,
) {
  if (claims.transport === "owner-grant") return ownerGrantDenial(options.resolveWorkspaceOwner, claims)
  return runtimeAccessTokenDenial(options.authority, claims)
}

export type RuntimeSessionAuthorityOptions = {
  authority: RuntimeSessionAuthorityPort
  /** Durable prompt admission is selected independently from session visibility. */
  turnAuthority?: SessionTurnAuthority
  env?: Record<string, string | undefined>
  ownerGrants?: OwnerGrantProof
  verifyRelayProof?: (token: string) => Promise<RelayHostPrivateSessionClaims>
  mintStreamLease?: (claims: SessionStreamLeaseClaims) => Promise<{ lease: string; expiresAt: number }>
  verifyStreamLease?: (lease: string) => Promise<SessionStreamLeaseClaims>
  mintTurnLease?: (claims: TurnLeaseClaims) => Promise<{ lease: string; expiresAt: number }>
  verifyTurnLease?: (lease: string) => Promise<TurnLeaseClaims>
}

/**
 * Narrow provider-neutral oracle for isolated workspace runtimes.
 *
 * Identity comes only from a verified RHT, a verified owner grant, or a short
 * lease minted from one of them, never from request JSON. Every stream
 * renewal checks the proof's own chain — the durable parent RAT, or the
 * workspace's current owner — and current private-session membership before
 * issuing another lease.
 */
export function RuntimeSessionAuthorityRoutes(options: RuntimeSessionAuthorityOptions) {
  const env = options.env ?? process.env
  const limitedBody = bodyLimit({
    maxSize: bodyLimitBytes,
    onError: (context) =>
      context.json(
        {
          error: {
            code: "request_body_too_large",
            message: `Request body exceeds the ${bodyLimitBytes}-byte limit`,
          },
        },
        413,
      ),
  })

  async function authorizeHost(
    context: Context,
    action: HostAuthorityAction,
    body: Record<string, unknown> | undefined,
  ) {
    if (body && Object.keys(body).some((key) => key !== "action" && key !== "lease")) {
      return context.json(
        {
          error: { code: "host_authority_request_invalid", message: "Host authority accepts only its action and a lease" },
        },
        400,
      )
    }
    const minimumRole = action === "host_admin" ? ("admin" as const) : ("viewer" as const)
    // A workspace lease renews itself: the reader's runtime access token is
    // rechecked, as it is for a relay host token, and a fresh lease minted.
    const lease = trimToUndefined(body?.lease)
    const held = lease
      ? await (options.verifyStreamLease ?? streamLeaseVerifier(env))(lease).catch(() => undefined)
      : undefined
    if (lease && (!held || held.sessionId !== WORKSPACE_STREAM_LEASE_SESSION || held.transport !== "relay-host")) {
      return context.json(
        { error: { code: "session_stream_lease_invalid", message: "Workspace stream lease is invalid or expired" } },
        401,
      )
    }
    let proof: PrivateSessionRuntimePrincipal & { orgId: string; workspaceId: string; hostId: string; parentRuntimeAccessTokenJti: string }
    if (held && held.transport === "relay-host") {
      proof = {
        ...sessionLeasePrincipal(held),
        orgId: held.orgId,
        workspaceId: held.workspaceId,
        hostId: held.hostId,
        parentRuntimeAccessTokenJti: held.parentRuntimeAccessTokenJti,
      }
    } else {
      const token = bearerToken(context.req.header("authorization") ?? null)
      if (!token) {
        return context.json(
          { error: { code: "relay_host_token_required", message: "Relay Host Token is required" } },
          401,
        )
      }
      const verified = await (options.verifyRelayProof ?? relayProofVerifier(env))(token).catch(() => undefined)
      if (!verified) {
        return context.json(
          { error: { code: "relay_host_token_invalid", message: "Relay Host Token is invalid or expired" } },
          401,
        )
      }
      if (!verified.role || roleRank(verified.role) < roleRank(minimumRole)) {
        return context.json(
          {
            error: { code: "host_authority_denied", message: `Workspace ${minimumRole} authority is required` },
          },
          403,
        )
      }
      proof = privateSessionRuntimeProof(verified)
    }
    const active = asRecord(
      await options.authority.runtimeAccessTokenActive({
        jti: proof.parentRuntimeAccessTokenJti,
        workspaceId: proof.workspaceId,
        hostId: proof.hostId,
        minimumRole,
      }),
    )
    if (active?.active !== true) {
      return context.json(
        {
          error: {
            code: trimToUndefined(active?.code) ?? "runtime_access_token_inactive",
            message: trimToUndefined(active?.reason) ?? "Runtime Access Token is inactive",
          },
        },
        401,
      )
    }
    if (action !== "host_read") return context.json({ allowed: true })
    // A plane without a lease signing key mints no lease here and none for a
    // session's stream either (`decideStream` answers 503), so its runtimes
    // serve no managed stream past a session's first frame; the workspace
    // read itself is still granted.
    const minter = options.mintStreamLease ?? streamLeaseMinter(env)
    const minted = await minter({
      ...sessionLeasePrincipal({ ...proof, transport: "relay-host", sessionId: WORKSPACE_STREAM_LEASE_SESSION, action: "read" }),
      transport: "relay-host",
      hostId: proof.hostId,
      parentRuntimeAccessTokenJti: proof.parentRuntimeAccessTokenJti,
      orgId: proof.orgId,
      workspaceId: proof.workspaceId,
      sessionId: WORKSPACE_STREAM_LEASE_SESSION,
      action: "read",
    }).catch(() => undefined)
    return context.json({ allowed: true, ...minted })
  }

  const resolveWorkspaceOwner = options.ownerGrants?.resolveWorkspaceOwner

  async function verifySessionProof(context: Context, request: SessionAuthorityRequest) {
    const { sessionId, action, lease, turnId, turnLeaseId, fencingToken } = request
    let claims: SessionStreamLeaseClaims
    let ownedTurn: TurnLeaseClaims | undefined
    /** The workspace role the relay asserted on THIS request; a lease carries none. */
    let relayRole: RelayHostPrivateSessionClaims["role"]
    const bearer = bearerToken(context.req.header("authorization") ?? null)
    if (bearer && options.ownerGrants?.names(bearer) && !lease && !turnLeaseId) {
      const grant = await options.ownerGrants.verify(bearer).catch(() => undefined)
      if (!grant || (await ownerGrantDenial(resolveWorkspaceOwner, grant))) {
        return context.json({ error: OWNER_GRANT_INVALID }, 401)
      }
      claims = {
        principalKind: "user",
        actorId: grant.actorId,
        actorKind: "human",
        transport: "owner-grant",
        orgId: grant.orgId,
        workspaceId: grant.workspaceId,
        sessionId,
        action: action === "write" ? "write" : "read",
      }
      return { claims, ownedTurn, relayRole, rechecked: true }
    }
    if ((action === "turn_renew" || action === "turn_release") && turnLeaseId) {
      const verified = await (options.verifyTurnLease ?? turnLeaseVerifier(env))(turnLeaseId).catch(() => undefined)
      if (
        !verified ||
        verified.sessionId !== sessionId ||
        verified.turnId !== turnId ||
        verified.fencingToken !== fencingToken
      ) {
        return context.json(
          {
            error: { code: "session_turn_lease_invalid", message: "Session turn lease is invalid or mismatched" },
          },
          401,
        )
      }
      ownedTurn = verified
      claims = verified
    } else if (lease) {
      const verified = await (options.verifyStreamLease ?? streamLeaseVerifier(env))(lease).catch(() => undefined)
      // A workspace lease stands for the reader on every session of its
      // workspace; the session named by the request is what is then authorized.
      const workspaceWide = verified?.sessionId === WORKSPACE_STREAM_LEASE_SESSION && verified.action === "read"
      if (!verified || (!workspaceWide && verified.sessionId !== sessionId) || verified.action !== action) {
        return context.json(
          {
            error: { code: "session_stream_lease_invalid", message: "Session stream lease is invalid or mismatched" },
          },
          401,
        )
      }
      claims = workspaceWide ? { ...verified, sessionId } : verified
    } else {
      const token = bearerToken(context.req.header("authorization") ?? null)
      if (!token) {
        return context.json(
          { error: { code: "relay_host_token_required", message: "Relay Host Token is required" } },
          401,
        )
      }
      const verified = await (options.verifyRelayProof ?? relayProofVerifier(env))(token).catch(() => undefined)
      if (!verified) {
        return context.json(
          {
            error: { code: "relay_host_token_invalid", message: "Relay Host Token is invalid or expired" },
          },
          401,
        )
      }
      try {
        relayRole = verified.role
        const proof = privateSessionRuntimeProof(verified)
        const principal: PrivateSessionRuntimePrincipal =
          proof.principalKind === "user"
            ? { principalKind: "user", actorId: proof.actorId, actorKind: "human" }
            : { principalKind: "service", actorId: proof.actorId, actorKind: "agent" }
        claims = {
          ...principal,
          transport: "relay-host",
          orgId: proof.orgId,
          workspaceId: proof.workspaceId,
          hostId: proof.hostId,
          parentRuntimeAccessTokenJti: proof.parentRuntimeAccessTokenJti,
          sessionId,
          action: action === "write" ? "write" : "read",
        }
      } catch {
        return context.json(
          {
            error: { code: "relay_host_token_invalid", message: "Relay Host Token claims are invalid" },
          },
          401,
        )
      }
    }

    return { claims, ownedTurn, relayRole, rechecked: false }
  }

  async function applyTurnAction(
    context: Context,
    request: SessionAuthorityRequest,
    claims: SessionStreamLeaseClaims,
    ownedTurn: TurnLeaseClaims | undefined,
    rechecked: boolean,
  ) {
    const { sessionId, action, turnId } = request
    const principal = sessionLeasePrincipal(claims)
    // Turn admission is reached only over a runtime's proof: the request
    // validation above accepts a stream lease only together with `stream`,
    // and `stream` is only ever a read/write action.
    if (claims.transport === "embedded") {
      return context.json(
        {
          error: {
            code: "session_turn_lease_invalid",
            message: "Session turn admission requires a Relay Host Token chain or an owner grant",
          },
        },
        401,
      )
    }
    const denial = rechecked ? undefined : await proofDenial({ authority: options.authority, resolveWorkspaceOwner }, claims)
    if (denial) return context.json({ error: denial }, 401)
    if (!options.turnAuthority) {
      return context.json(
        {
          error: {
            code: "session_turn_authority_unavailable",
            message: "Durable session turn authority is not configured",
          },
        },
        503,
      )
    }
    const turn = {
      ...principal,
      sessionId,
      workspaceId: claims.workspaceId,
      turnId: turnId!,
    }
    if (action === "turn_acquire") {
      const acquired = await options.turnAuthority.acquireSessionTurn(turn)
      const proof = await (options.mintTurnLease ?? turnLeaseMinter(env))({
        ...claims,
        action: "write",
        turnId: acquired.turnId,
        authorityLeaseId: acquired.leaseId,
        fencingToken: acquired.fencingToken,
        acquiredAt: acquired.acquiredAt,
        expiresAt: acquired.expiresAt,
      })
      return context.json({ ...acquired, leaseId: proof.lease, expiresAt: proof.expiresAt })
    }
    const owned = {
      ...turn,
      leaseId: ownedTurn!.authorityLeaseId,
      fencingToken: ownedTurn!.fencingToken,
    }
    if (action === "turn_renew") {
      const renewed = await options.turnAuthority.renewSessionTurn(owned)
      const proof = await (options.mintTurnLease ?? turnLeaseMinter(env))({
        ...ownedTurn!,
        authorityLeaseId: renewed.leaseId,
        fencingToken: renewed.fencingToken,
        acquiredAt: renewed.acquiredAt,
        expiresAt: renewed.expiresAt,
      })
      return context.json({ ...renewed, leaseId: proof.lease, expiresAt: proof.expiresAt })
    }
    return context.json(await options.turnAuthority.releaseSessionTurn(owned))
  }

  return new Hono().post("/session-authorize", limitedBody, async (context) => {
    const body = await readJsonRecord(context.req.raw)
    if (isHostAuthorityAction(body?.action)) return authorizeHost(context, body.action, body)
    const request = parseSessionAuthorityRequest(body)
    if (!request) {
      return context.json(
        {
          error: {
            code: "session_authority_request_invalid",
            message: "sessionId, action, and exact registration operation fields are required",
          },
        },
        400,
      )
    }
    const { sessionId, action, operationId, reason, title, stream, parentSessionId } = request
    const verified = await verifySessionProof(context, request)
    if (verified instanceof Response) return verified
    const { claims, ownedTurn, relayRole, rechecked } = verified

    try {
      const principal = sessionLeasePrincipal(claims)
      if (action === "reserve") {
        // A reservation names the creator, and the only creator a runtime may
        // name is the owner its grant re-resolves to; a relay host's actor
        // reserved its own sessions before it ever reached the runtime.
        if (claims.transport !== "owner-grant") {
          return context.json(
            { error: { code: "session_reservation_requires_owner_grant", message: "Only an owner grant may reserve a session here" } },
            401,
          )
        }
        if (!options.authority.reserveRuntimeSession) {
          return context.json(
            { error: { code: "session_registration_unavailable", message: "Session registration is unavailable" } },
            503,
          )
        }
        // An intent that names a parent is a `fork`: that is the pairing both
        // adapters validate and the one their `sessions` CHECK constraint
        // admits. The parent read is theirs too — they resolve it in the same
        // statement that writes the reservation, so a parent the caller loses
        // between the check and the write cannot be reserved under.
        const reserved = await options.authority.reserveRuntimeSession(principal, {
          operationId: `session_registration_${randomUUID()}`,
          sessionId,
          workspaceId: claims.workspaceId,
          kind: "fork",
          parentSessionId,
          ...(title ? { title } : {}),
        })
        return context.json({ allowed: true, operationId: reserved.operationId })
      }
      if (action === "adopt") {
        // The machine asks on behalf of the person at its keyboard, over the
        // relay, holding a token the relay minted for THIS request; a lease
        // outlives the role it was minted under and cannot carry this.
        if (claims.transport !== "relay-host" || relayRole !== "owner") {
          return context.json(
            {
              error: {
                code: "session_adoption_requires_host_owner",
                message: "Only the owner of the machine serving this workspace may adopt a session it already holds",
              },
            },
            403,
          )
        }
        if (!options.authority.adoptRuntimeSession) {
          return context.json(
            { error: { code: "session_registration_unavailable", message: "Session registration is unavailable" } },
            503,
          )
        }
        const denial = rechecked ? undefined : await proofDenial({ authority: options.authority, resolveWorkspaceOwner }, claims)
        if (denial) return context.json({ error: denial }, 401)
        const adopted = await options.authority.adoptRuntimeSession({
          ...principal,
          sessionId,
          workspaceId: claims.workspaceId,
          hostId: claims.hostId,
          ...(title ? { title } : {}),
        })
        return context.json({ allowed: true, adopted: adopted.adopted })
      }
      if (action === "register") {
        await options.authority.registerRuntimeSession({
          ...principal,
          operationId,
          sessionId,
          workspaceId: claims.workspaceId,
          ...(title ? { title } : {}),
        })
        return context.json({ allowed: true })
      }
      if (action === "registration_ambiguous" || action === "compensation_begin" || action === "compensation_complete") {
        const input = {
          ...principal,
          operationId,
          sessionId,
          workspaceId: claims.workspaceId,
          reason,
        }
        if (action === "registration_ambiguous") {
          await options.authority.markSessionRegistrationAmbiguous(input)
        } else if (action === "compensation_begin") {
          await options.authority.beginSessionCompensation(input)
        } else {
          await options.authority.completeSessionCompensation(input)
        }
        return context.json({ allowed: true })
      }

      if (isTurnAction(action)) return await applyTurnAction(context, request, claims, ownedTurn, rechecked)

      if (stream) {
        const decision = await authorizeRuntimeSessionStream(
          {
            authority: options.authority,
            ...(resolveWorkspaceOwner ? { resolveWorkspaceOwner } : {}),
            ...(options.mintStreamLease ? { mintStreamLease: options.mintStreamLease } : {}),
            env,
          },
          claims,
          { rechecked },
        )
        if (!decision.allowed) {
          return context.json({ error: { code: decision.code, message: decision.message } }, decision.status)
        }
        return context.json({ allowed: true, lease: decision.lease, expiresAt: decision.expiresAt })
      }
      await options.authority.authorizeRuntimeSession({
        ...principal,
        sessionId,
        workspaceId: claims.workspaceId,
        action,
        ...(request.writeClass ? { writeClass: request.writeClass } : {}),
      })
      return context.json({ allowed: true })
    } catch (error) {
      if (error instanceof SessionTurnConflictError || error instanceof SessionTurnLeaseLostError) {
        return context.json(
          {
            error: {
              code: error.code,
              message: error.message,
              ...(error instanceof SessionTurnConflictError && error.activeUntil !== undefined
                ? { activeUntil: error.activeUntil }
                : {}),
            },
          },
          409,
        )
      }
      if (error instanceof ControlPlaneAuthError) {
        return context.json(controlPlaneAuthErrorBody(error), error.status)
      }
      return context.json(
        {
          error: { code: "session_authority_unavailable", message: "Session authority is temporarily unavailable" },
        },
        503,
      )
    }
  })
}

function parseSessionAuthorityRequest(body: Record<string, unknown> | undefined) {
  const sessionId = trimToUndefined(body?.sessionId)
  const action = body?.action
  const writeClass = body?.writeClass
  const operationId = trimToUndefined(body?.operationId)
  const reason = optionalText(body?.reason)
  const title = optionalText(body?.title)
  const parentSessionId = trimToUndefined(body?.parentSessionId)
  const stream = body?.stream === true
  const lease = trimToUndefined(body?.lease)
  const turnId = trimToUndefined(body?.turnId)
  const turnLeaseId = trimToUndefined(body?.leaseId)
  const fencingToken = positiveInteger(body?.fencingToken)
  if (!sessionId || !isAuthorityAction(action)) return undefined
  if (
    (writeClass !== undefined && !isSessionWriteClass(writeClass))
    || (writeClass !== undefined && action !== "write")
    || (body?.title !== undefined && title === undefined)
    || (body?.reason !== undefined && reason === undefined)
    || (body?.stream !== undefined && typeof body.stream !== "boolean")
    || (body?.lease !== undefined && !lease)
    || (!!lease && !stream)
    || (stream && action !== "read" && action !== "write")
  ) return undefined
  const fields = {
    sessionId,
    operationId,
    reason,
    title,
    stream,
    lease,
    turnId,
    turnLeaseId,
    fencingToken,
    parentSessionId,
    ...(isSessionWriteClass(writeClass) ? { writeClass } : {}),
  }
  switch (action) {
    case "reserve":
      if (!parentSessionId) return undefined
      return { ...fields, action, parentSessionId }
    case "register":
      if (!operationId) return undefined
      return { ...fields, action, operationId }
    case "registration_ambiguous":
    case "compensation_begin":
    case "compensation_complete":
      if (!operationId || !reason) return undefined
      return { ...fields, action, operationId, reason }
    case "turn_acquire":
      if (!turnId || body?.leaseId !== undefined || body?.fencingToken !== undefined) return undefined
      return { ...fields, action, turnId }
    case "turn_renew":
    case "turn_release":
      if (!turnId || !turnLeaseId || !fencingToken) return undefined
      return { ...fields, action, turnId, turnLeaseId, fencingToken }
    default:
      return { ...fields, action }
  }
}

type SessionAuthorityRequest = NonNullable<ReturnType<typeof parseSessionAuthorityRequest>>

type AuthorityAction =
  | "read"
  | "write"
  | "reserve"
  | "register"
  | "adopt"
  | "registration_ambiguous"
  | "compensation_begin"
  | "compensation_complete"
  | "turn_acquire"
  | "turn_renew"
  | "turn_release"

type HostAuthorityAction = "host_read" | "host_admin"

function isHostAuthorityAction(value: unknown): value is HostAuthorityAction {
  return value === "host_read" || value === "host_admin"
}

function isAuthorityAction(value: unknown): value is AuthorityAction {
  return value === "read"
    || value === "write"
    || value === "reserve"
    || value === "register"
    || value === "adopt"
    || value === "registration_ambiguous"
    || value === "compensation_begin"
    || value === "compensation_complete"
    || value === "turn_acquire"
    || value === "turn_renew"
    || value === "turn_release"
}

function isSessionWriteClass(value: unknown): value is SessionWriteClass {
  return value === "agent_turn" || value === "session_control"
}

function isTurnAction(value: AuthorityAction): value is "turn_acquire" | "turn_renew" | "turn_release" {
  return value === "turn_acquire" || value === "turn_renew" || value === "turn_release"
}

function streamLeaseMinter(env: Record<string, string | undefined>) {
  return async (claims: SessionStreamLeaseClaims) => {
    const pem = keyPem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM)
    if (!pem) throw new Error("Stream lease signing key is unavailable")
    const now = Math.floor(Date.now() / 1_000)
    const ttlSeconds = SESSION_STREAM_LEASE_TTL_MS / 1_000
    const expiresAt = (now + ttlSeconds) * 1_000
    const lease = await new SignJWT({
      principal_kind: claims.principalKind,
      actor_id: claims.actorId,
      actor_kind: claims.actorKind,
      org_id: claims.orgId,
      workspace_id: claims.workspaceId,
      transport: claims.transport,
      ...(claims.transport === "relay-host"
        ? { host_id: claims.hostId, parent_jti: claims.parentRuntimeAccessTokenJti }
        : {}),
      session_id: claims.sessionId,
      action: claims.action,
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(streamLeaseIssuer)
      .setAudience(streamLeaseAudience)
      .setIssuedAt(now)
      .setExpirationTime(now + ttlSeconds)
      .setJti(crypto.randomUUID())
      .sign(await importPKCS8(pem, "EdDSA"))
    return { lease, expiresAt }
  }
}

function streamLeaseVerifier(env: Record<string, string | undefined>) {
  return async (lease: string): Promise<SessionStreamLeaseClaims> => {
    const pem = keyPem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM)
    if (!pem) throw new Error("Stream lease verification key is unavailable")
    const { payload } = await jwtVerify(lease, await importSPKI(pem, "EdDSA"), {
      algorithms: ["EdDSA"],
      issuer: streamLeaseIssuer,
      audience: streamLeaseAudience,
    })
    const principalKind = payload.principal_kind
    const actorKind = payload.actor_kind
    if (
      (principalKind !== "user" && principalKind !== "service")
      || (actorKind !== "human" && actorKind !== "agent")
      || (principalKind === "user" && actorKind !== "human")
      || (principalKind === "service" && actorKind !== "agent")
    ) throw new Error("Stream lease principal is invalid")
    const actorId = trimToUndefined(payload.actor_id)
    const orgId = trimToUndefined(payload.org_id)
    const workspaceId = trimToUndefined(payload.workspace_id)
    const hostId = trimToUndefined(payload.host_id)
    const parentRuntimeAccessTokenJti = trimToUndefined(payload.parent_jti)
    const sessionId = trimToUndefined(payload.session_id)
    const action = payload.action
    const transport = payload.transport
    if (!actorId || !orgId || !workspaceId || !sessionId
      || (action !== "read" && action !== "write")) throw new Error("Stream lease claims are invalid")
    const binding: SessionStreamLeaseBinding = transport === "embedded"
      ? { transport: "embedded" }
      : transport === "owner-grant"
        ? { transport: "owner-grant" }
        : transport === "relay-host" && hostId && parentRuntimeAccessTokenJti
          ? { transport: "relay-host", hostId, parentRuntimeAccessTokenJti }
          : (() => { throw new Error("Stream lease binding is invalid") })()
    const principal: PrivateSessionRuntimePrincipal = principalKind === "user"
      ? { principalKind: "user", actorId, actorKind: "human" }
      : { principalKind: "service", actorId, actorKind: "agent" }
    return {
      ...principal,
      ...binding,
      orgId,
      workspaceId,
      sessionId,
      action,
    }
  }
}

function turnLeaseMinter(env: Record<string, string | undefined>) {
  return async (claims: TurnLeaseClaims) => {
    const pem = keyPem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM)
    if (!pem) throw new Error("Turn lease signing key is unavailable")
    const now = Math.floor(Date.now() / 1_000)
    const expiry = Math.floor(claims.expiresAt / 1_000)
    if (expiry <= now) throw new Error("Turn lease already expired before proof minting")
    const lease = await new SignJWT({
      principal_kind: claims.principalKind,
      actor_id: claims.actorId,
      actor_kind: claims.actorKind,
      org_id: claims.orgId,
      workspace_id: claims.workspaceId,
      transport: claims.transport,
      ...(claims.transport === "relay-host"
        ? { host_id: claims.hostId, parent_jti: claims.parentRuntimeAccessTokenJti }
        : {}),
      session_id: claims.sessionId,
      action: "write",
      turn_id: claims.turnId,
      authority_lease_id: claims.authorityLeaseId,
      fencing_token: claims.fencingToken,
      acquired_at: claims.acquiredAt,
      authority_expires_at: claims.expiresAt,
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(turnLeaseIssuer)
      .setAudience(turnLeaseAudience)
      .setIssuedAt(now)
      .setExpirationTime(expiry)
      .setJti(crypto.randomUUID())
      .sign(await importPKCS8(pem, "EdDSA"))
    return { lease, expiresAt: expiry * 1_000 }
  }
}

function turnLeaseVerifier(env: Record<string, string | undefined>) {
  return async (lease: string): Promise<TurnLeaseClaims> => {
    const pem = keyPem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM)
    if (!pem) throw new Error("Turn lease verification key is unavailable")
    const { payload } = await jwtVerify(lease, await importSPKI(pem, "EdDSA"), {
      algorithms: ["EdDSA"],
      issuer: turnLeaseIssuer,
      audience: turnLeaseAudience,
    })
    const principalKind = payload.principal_kind
    const actorKind = payload.actor_kind
    if (
      (principalKind !== "user" && principalKind !== "service")
      || (actorKind !== "human" && actorKind !== "agent")
      || (principalKind === "user" && actorKind !== "human")
      || (principalKind === "service" && actorKind !== "agent")
    ) throw new Error("Turn lease principal is invalid")
    const actorId = trimToUndefined(payload.actor_id)
    const orgId = trimToUndefined(payload.org_id)
    const workspaceId = trimToUndefined(payload.workspace_id)
    const hostId = trimToUndefined(payload.host_id)
    const parentRuntimeAccessTokenJti = trimToUndefined(payload.parent_jti)
    const sessionId = trimToUndefined(payload.session_id)
    const turnId = trimToUndefined(payload.turn_id)
    const authorityLeaseId = trimToUndefined(payload.authority_lease_id)
    const fencingToken = positiveInteger(payload.fencing_token)
    const acquiredAt = finiteTimestamp(payload.acquired_at)
    const expiresAt = finiteTimestamp(payload.authority_expires_at)
    const transport = payload.transport
    if (
      !actorId || !orgId || !workspaceId
      || !sessionId || !turnId || !authorityLeaseId || !fencingToken
      || acquiredAt === undefined || expiresAt === undefined || expiresAt <= acquiredAt
    ) throw new Error("Turn lease claims are invalid")
    const binding: Extract<SessionStreamLeaseBinding, { transport: "relay-host" | "owner-grant" }> = transport === "owner-grant"
      ? { transport: "owner-grant" }
      : hostId && parentRuntimeAccessTokenJti
        ? { transport: "relay-host", hostId, parentRuntimeAccessTokenJti }
        : (() => { throw new Error("Turn lease binding is invalid") })()
    const principal: PrivateSessionRuntimePrincipal = principalKind === "user"
      ? { principalKind: "user", actorId, actorKind: "human" }
      : { principalKind: "service", actorId, actorKind: "agent" }
    return {
      ...principal,
      ...binding,
      orgId,
      workspaceId,
      sessionId,
      action: "write",
      turnId,
      authorityLeaseId,
      fencingToken,
      acquiredAt,
      expiresAt,
    }
  }
}

type RelayProofKey = JWTVerifyGetKey
const relayKeys = new Map<string, RelayProofKey | Promise<RelayProofKey>>()

export function relayProofVerifier(env: Record<string, string | undefined>) {
  return async (token: string): Promise<RelayHostPrivateSessionClaims> => {
    const { payload } = await jwtVerify(token, await relayProofKey(env), {
      algorithms: ["EdDSA", "ES256", "RS256"],
      issuer: "workspace-relay",
      audience: "workspace-host-service",
    })
    const principalKind = payload.principal_kind
    const actorKind = payload.actor_kind
    const role = payload.role
    const backing = payload.backing
    const actorId = trimToUndefined(payload.actor_id)
    const orgId = trimToUndefined(payload.org_id)
    const workspaceId = trimToUndefined(payload.workspace_id)
    const hostId = trimToUndefined(payload.host_id)
    const jti = trimToUndefined(payload.jti)
    const parentJti = trimToUndefined(payload.parent_jti)
    if (
      (principalKind !== "user" && principalKind !== "service")
      || (actorKind !== "human" && actorKind !== "agent")
      || !actorId
      || !orgId
      || !workspaceId
      || !hostId
      || !jti
      || !parentJti
      || (role !== "viewer" && role !== "editor" && role !== "admin" && role !== "owner")
      || payload.access !== undefined
      || (backing !== "cloud-vm" && backing !== "local-worktree")
    ) throw new Error("Relay proof claims are invalid")
    // Assembled AFTER the checks so the claims object is the narrowed values,
    // not the raw payload asserted into their type.
    const claims: RelayHostPrivateSessionClaims = {
      principal_kind: principalKind,
      actor_id: actorId,
      actor_kind: actorKind,
      org_id: orgId,
      workspace_id: workspaceId,
      host_id: hostId,
      jti,
      parent_jti: parentJti,
      role,
    }
    return claims
  }
}

function roleRank(role: "viewer" | "editor" | "admin" | "owner") {
  return role === "viewer" ? 0 : role === "editor" ? 1 : role === "admin" ? 2 : 3
}

function relayProofKey(env: Record<string, string | undefined>): RelayProofKey | Promise<RelayProofKey> {
  const jwksUrl = trimToUndefined(env.CLAXEDO_RELAY_JWKS_URL)
  if (jwksUrl) return cachedKey(`jwks:${jwksUrl}`, () => createRemoteJWKSet(new URL(jwksUrl)))
  const pem = keyPem(env.CLAXEDO_RELAY_HOST_VERIFY_PEM)
  if (pem) return cachedKey(`pem:${pem}`, () => async () => await importSPKI(pem, "EdDSA"))
  const jwk = trimToUndefined(env.CLAXEDO_RELAY_HOST_PUBLIC_KEY_JWK)
  if (jwk) return cachedKey(`jwk:${jwk}`, () => async () => await importJWK(JSON.parse(jwk), "EdDSA"))
  throw new Error("Relay proof verification is not configured")
}

function cachedKey(key: string, create: () => RelayProofKey | Promise<RelayProofKey>) {
  const existing = relayKeys.get(key)
  if (existing) return existing
  const value = create()
  relayKeys.set(key, value)
  return value
}

function optionalText(value: unknown) {
  if (value === undefined) return ""
  return trimToUndefined(value)
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function finiteTimestamp(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function keyPem(value: string | undefined) {
  return trimToUndefined(value)?.replaceAll("\\n", "\n")
}


