import { randomUUID } from "node:crypto"
import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { bearerToken } from "@claxedo/server-core/platform/auth/auth"
import { asRecord } from "@claxedo/helpers/guards"
import {
  privateSessionRuntimeProof,
  type PrivateSessionAuthority,
  type PrivateSessionRuntimePrincipal,
  type RelayHostPrivateSessionClaims,
} from "@claxedo/server-core/platform/auth/private-session-authority"
import { SessionTurnGrantError, type SessionTurnAuthority } from "@claxedo/server-core/platform/auth/session-turn-authority"
import { sessionHostRootOf } from "@claxedo/workspace-relay-protocol"
import { readJsonRecord } from "@claxedo/server-core/platform/json/index"
import type { WorkspaceAuthority, WorkspaceOwnerIdentity } from "@claxedo/server-core/platform/auth/authority"
import type { TurnUsageRevision, UsageOwner } from "@claxedo/server-core/usage/contracts"
import {
  cloudWorkspaceUsageRevision,
  readUsageReportFacts,
  usageReportFactInBounds,
  USAGE_REPORT_ACTION,
  type UsageReportFact,
  type UsageReportResult,
  type UsageReportWriter,
} from "@claxedo/server-core/usage/usage-report"
import type { ConnectionTurnCredentials } from "../connections/turn-credentials"
import { connectionTurnOwner } from "../connections/turn-owner"
import {
  deferredTurnGrantClaims,
  mintDeferredTurnGrant,
  verifyDeferredTurnGrant,
  type DeferredTurnGrantClaims,
} from "../session/deferred-turn-grant"
import { trimToUndefined } from "@claxedo/helpers/string"
import { sessionAuthorityErrorAnswer } from "../session/runtime-authority-errors"
import { RuntimeSandboxSecretRoutes, type RuntimeSandboxSecretOptions } from "./runtime-sandbox-secrets"
import { SessionHostDeliveryRoutes, type SessionHostDeliveryOptions } from "./session-host-delivery"
import { placedSessionHostRoot, type SessionHostAuthority } from "../authority/session-hosts"
import {
  proofHost,
  relayProofVerifier,
  sessionLeasePrincipal,
  streamLeaseMinter,
  streamLeaseVerifier,
  turnLeaseMinter,
  turnLeaseVerifier,
  WORKSPACE_STREAM_LEASE_SESSION,
  type DeferredGrantBinding,
  type SessionProofClaims,
  type SessionStreamLeaseClaims,
  type TurnLeaseClaims,
} from "../session/runtime-session-proofs"
import {
  isHostAuthorityAction,
  isTurnAction,
  parseSessionAuthorityRequest,
  positiveInteger,
  type HostAuthorityAction,
  type SessionAuthorityRequest,
} from "../session/runtime-authority-request"

const bodyLimitBytes = 16 * 1024
type RuntimeSessionAuthorityPort = Pick<
  PrivateSessionAuthority,
  | "registerRuntimeSession"
  | "markSessionRegistrationAmbiguous"
  | "beginSessionCompensation"
  | "completeSessionCompensation"
  | "authorizeRuntimeSessionStartStatus"
  | "authorizeRuntimeSessionStart"
  | "authorizeRuntimeSession"
> & {
  runtimeAccessTokenActive: (input: { jti: string; workspaceId: string; hostId: string }) => Promise<unknown>
  /** Absent on a port that cannot name a workspace's owner; minted turn credentials then bind no personal rows. */
  resolveWorkspaceOwner?: ResolveWorkspaceOwner
  /** Absent on a plane that cannot reserve for a runtime actor; the owner grant's `reserve` then answers 503. */
  reserveRuntimeSession?: PrivateSessionAuthority["reserveRuntimeSession"]
  /** Absent on a plane that records no host enrollments; `adopt` then answers 503. */
  adoptRuntimeSession?: PrivateSessionAuthority["adoptRuntimeSession"]
  /** Absent on a plane that records no turn producers; a usage report then answers 503. */
  resolveCloudTurnUsageOwner?: WorkspaceAuthority["resolveCloudTurnUsageOwner"]
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

export type RuntimeSessionStreamDecision =
  | { allowed: true; lease: string; expiresAt: number }
  | { allowed: false; status: 401; code: string; message: string }

export type RuntimeSessionStreamOptions = {
  authority: Pick<RuntimeSessionAuthorityPort, "authorizeRuntimeSession" | "runtimeAccessTokenActive">
  /** Absent on a plane that mints no owner grants; a lease bound to one is then refused at renewal. */
  resolveWorkspaceOwner?: ResolveWorkspaceOwner
  env?: Record<string, string | undefined>
}

// Held stream leases must recheck both session access and their parent token
// at renewal, even when the request's bearer was verified at establishment.
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
  return { allowed: true, ...await streamLeaseMinter(options.env ?? process.env)(claims) }
}

async function runtimeAccessTokenDenial(
  authority: Pick<RuntimeSessionAuthorityPort, "runtimeAccessTokenActive">,
  claims: Extract<SessionProofClaims, { transport: "relay-host" }>,
) {
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
  claims: SessionProofClaims,
) {
  if (claims.transport === "relay-host") return runtimeAccessTokenDenial(options.authority, claims)
  if (claims.transport === "owner-grant") return ownerGrantDenial(options.resolveWorkspaceOwner, claims)
  return undefined
}

export type RuntimeSessionAuthorityOptions = RuntimeSandboxSecretOptions & {
  /** Where a session is placed; absent, no session is served by its own host and every session-host proof is refused. */
  sessionHosts?: Pick<SessionHostAuthority, "readSessionHostPlacement">
  /** What a session served by its own Durable Object is handed per turn; absent, `/turn-delivery` and `/turn-execution` are not mounted. */
  sessionHostDelivery?: SessionHostDeliveryOptions
  authority: RuntimeSessionAuthorityPort
  /** Durable prompt admission is selected independently from session visibility. */
  turnAuthority?: SessionTurnAuthority
  /**
   * The connections turn credentials this admission mints into: a runtime that
   * holds an admitted turn receives a credential bound to the session and the
   * turn's subject, dead when the lease ends.
   */
  turnCredentials?: ConnectionTurnCredentials
  env?: Record<string, string | undefined>
  ownerGrants?: OwnerGrantProof
  verifyRelayProof?: (token: string) => Promise<RelayHostPrivateSessionClaims>
  mintTurnLease?: (claims: TurnLeaseClaims) => Promise<{ lease: string; expiresAt: number }>
  verifyTurnLease?: (lease: string) => Promise<TurnLeaseClaims>
  /** Where a cloud workspace's usage reports are filed; absent, a report answers 503. */
  usageWriter?: UsageReportWriter
}

const USAGE_REPORT_KEYS: ReadonlySet<string> = new Set(["action", "sessionId", "turnId", "leaseId", "fencingToken", "facts"])

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
    // A workspace lease renews itself: the reader's runtime access token is
    // rechecked, as it is for a relay host token, and a fresh lease minted.
    const lease = trimToUndefined(body?.lease)
    const held = lease
      ? await streamLeaseVerifier(env)(lease).catch(() => undefined)
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
      if (verified.session_id !== undefined || sessionHostRootOf(verified.host_id)) {
        return context.json(
          { error: { code: "host_authority_denied", message: "A token scoped to one session reaches no workspace capability" } },
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
    const minter = streamLeaseMinter(env)
    const minted = await minter({
      ...sessionLeasePrincipal(proof),
      transport: "relay-host",
      hostId: proof.hostId,
      parentRuntimeAccessTokenJti: proof.parentRuntimeAccessTokenJti,
      orgId: proof.orgId,
      workspaceId: proof.workspaceId,
      sessionId: WORKSPACE_STREAM_LEASE_SESSION,
      action: "read",
    }).catch(() => undefined)
    if (!minted) return context.json({ error: {
      code: "session_stream_authority_unavailable",
      message: "Workspace stream lease could not be issued",
    } }, 503)
    return context.json({ allowed: true, ...minted })
  }

  const resolveWorkspaceOwner = options.ownerGrants?.resolveWorkspaceOwner

  /**
   * A session placed in its own Durable Object answers to that host alone, and
   * a host answers for no session placed elsewhere: whatever the action, the
   * host behind the proof must be the one the session's row, or before
   * registration its reservation, names.
   */
  async function sessionHostMismatch(claims: SessionProofClaims, sessionId: string) {
    const host = proofHost(claims)
    const proven = host === undefined ? undefined : sessionHostRootOf(host)
    const placement = await options.sessionHosts?.readSessionHostPlacement({ workspaceId: claims.workspaceId, sessionId })
    return proven !== placedSessionHostRoot(placement)
  }

  /**
   * A cloud workspace runtime's usage for one session, proven by a turn lease
   * the plane minted for that session. Session and workspace come from the
   * lease, location and host from the plane; the report names none of them.
   * Each fact names the turn it was metered under and is owned by that turn's
   * recorded producer, so a fact retried under a later turn's lease stays its
   * own turn's. A fact is refused alone when it is out of bounds, when its
   * turn is not one a cloud workspace's session admitted for an account, or
   * when its turn already holds the most messages one turn files; a malformed
   * fact, or too many of them, refuses the report.
   * The lease may already be released: it proves the turn was admitted, and
   * its own expiry bounds how late a report can arrive.
   */
  async function reportUsage(context: Context, body: Record<string, unknown>) {
    const sessionId = trimToUndefined(body.sessionId)
    const turnId = trimToUndefined(body.turnId)
    const leaseId = trimToUndefined(body.leaseId)
    const fencingToken = positiveInteger(body.fencingToken)
    const facts = readUsageReportFacts(body.facts)
    if (Object.keys(body).some((key) => !USAGE_REPORT_KEYS.has(key)) || !sessionId || !turnId || !leaseId || !fencingToken || !facts) {
      return context.json(
        { error: { code: "usage_report_invalid", message: "A usage report carries a session turn lease and well-formed facts only" } },
        400,
      )
    }
    const lease = await (options.verifyTurnLease ?? turnLeaseVerifier(env))(leaseId).catch(() => undefined)
    if (!lease || lease.sessionId !== sessionId || lease.turnId !== turnId || lease.fencingToken !== fencingToken) {
      return context.json(
        { error: { code: "session_turn_lease_invalid", message: "Session turn lease is invalid or mismatched" } },
        401,
      )
    }
    if (await sessionHostMismatch(lease, sessionId)) return sessionHostRefusal(context)
    let revisions: Array<{ fact: UsageReportFact; revision: TurnUsageRevision }>
    try {
      revisions = facts.map((fact) => ({ fact, revision: cloudWorkspaceUsageRevision(fact, lease) }))
    } catch {
      return context.json({ error: { code: "usage_report_invalid", message: "A reported usage revision is malformed" } }, 400)
    }
    try {
      const denial = await proofDenial({ authority: options.authority, resolveWorkspaceOwner }, lease)
      if (denial) return context.json({ error: denial }, 401)
      const writer = options.usageWriter
      const authority = options.authority
      if (!writer || !authority.resolveCloudTurnUsageOwner) {
        return context.json({ error: { code: "usage_report_unavailable", message: "Usage reporting is not configured" } }, 503)
      }
      const window = { admittedAt: lease.acquiredAt, now: Date.now() }
      const inBounds = revisions.filter(({ fact }) => usageReportFactInBounds(fact, window))
      const owners = new Map<string, UsageOwner | undefined>()
      for (const factTurnId of new Set(inBounds.map(({ fact }) => fact.turnId))) {
        owners.set(factTurnId, await authority.resolveCloudTurnUsageOwner({ sessionId, turnId: factTurnId }))
      }
      const results: UsageReportResult[] = []
      for (const item of revisions) {
        const { fact, revision } = item
        const reported = { messageId: revision.messageId, revision: revision.revision }
        const owner = owners.get(fact.turnId)
        if (!inBounds.includes(item)) results.push({ ...reported, status: "refused", code: "usage_fact_out_of_bounds" })
        else if (!owner) results.push({ ...reported, status: "refused", code: "usage_owner_unresolved" })
        else results.push({ ...reported, ...await writer.writeRevision(revision, { owner, turnId: fact.turnId, ...(fact.turnId === lease.turnId ? { admittedAt: lease.acquiredAt } : {}) }) })
      }
      return context.json({ results })
    } catch {
      return context.json(
        { error: { code: "session_authority_unavailable", message: "Session authority is temporarily unavailable" } },
        503,
      )
    }
  }

  /**
   * A proof that only ever admits a turn — a lease over an owned turn, or a
   * deferred grant — is answered apart from one that also opens streams and
   * plain reads, so nothing downstream can mint a stream lease from it.
   */
  type SessionProof =
    | {
        claims: SessionStreamLeaseClaims
        /** The session the relay's token on THIS request is scoped to, or none for the owner's; a lease carries neither. */
        relayScope: { sessionId?: string } | undefined
        rechecked: boolean
      }
    | { turn: { claims: SessionProofClaims; ownedTurn: TurnLeaseClaims | undefined; rechecked: boolean } }

  async function verifySessionProof(context: Context, request: SessionAuthorityRequest): Promise<Response | SessionProof> {
    const { sessionId, action, lease, turnId, turnLeaseId, fencingToken } = request
    let claims: SessionStreamLeaseClaims
    let relayScope: { sessionId?: string } | undefined
    const bearer = bearerToken(context.req.header("authorization") ?? null)
    if (request.action === "turn_acquire" && request.grant) {
      if (bearer) {
        return context.json(
          { error: { code: "session_turn_grant_invalid", message: "A deferred turn grant stands in for a bearer, never beside one" } },
          400,
        )
      }
      let verified: DeferredTurnGrantClaims
      try {
        verified = await verifyDeferredTurnGrant(request.grant, env, { sessionId })
      } catch (error) {
        if (error instanceof SessionTurnGrantError) return context.json({ error: { code: error.code, message: error.message } }, 401)
        return context.json(
          { error: { code: "session_authority_unavailable", message: "Deferred turn grant could not be verified" } },
          503,
        )
      }
      const binding: DeferredGrantBinding = { transport: "deferred-grant", grantId: verified.grantId, ...(verified.hostId ? { hostId: verified.hostId } : {}) }
      const claims: SessionProofClaims = {
        ...sessionLeasePrincipal(verified),
        ...binding,
        orgId: verified.orgId,
        workspaceId: verified.workspaceId,
        sessionId,
        action: "write",
      }
      return { turn: { claims, ownedTurn: undefined, rechecked: true } }
    }
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
      return { claims, relayScope, rechecked: true }
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
      return { turn: { claims: verified, ownedTurn: verified, rechecked: false } }
    } else if (lease) {
      const verified = await streamLeaseVerifier(env)(lease).catch(() => undefined)
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
      if (verified.session_id !== undefined && verified.session_id !== sessionId) {
        return context.json({ error: { code: "session_scope_denied", message: "The relay's token reaches another session" } }, 403)
      }
      try {
        relayScope = verified.session_id === undefined ? {} : { sessionId: verified.session_id }
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

    return { claims, relayScope, rechecked: false }
  }


  async function applyTurnAction(
    context: Context,
    request: SessionAuthorityRequest,
    claims: SessionProofClaims,
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
    if (request.action === "turn_grant") {
      const granted = await options.turnAuthority.grantSessionTurn({
        ...principal,
        sessionId,
        workspaceId: claims.workspaceId,
        intent: request.intent,
        ...(request.subjectSessionId ? { subjectSessionId: request.subjectSessionId } : {}),
        ...(request.registrationOperationId ? { registrationOperationId: request.registrationOperationId } : {}),
        ...(turnId ? { turnId } : {}),
      })
      const minted = await mintDeferredTurnGrant(deferredTurnGrantClaims(principal, claims.orgId, granted, proofHost(claims)), env)
      return context.json({ allowed: true, grant: minted.grant, expiresAt: granted.expiresAt })
    }
    const turn = {
      ...principal,
      sessionId,
      workspaceId: claims.workspaceId,
      turnId: turnId!,
    }
    if (action === "turn_acquire") {
      const subject = await connectionTurnOwner(options.turnCredentials, (id) => options.authority.resolveWorkspaceOwner?.(id) ?? Promise.resolve(undefined), claims.workspaceId)
      const acquired = await options.turnAuthority.acquireSessionTurn({
        ...turn,
        ...(claims.transport === "deferred-grant" ? { grantId: claims.grantId } : {}),
      })
      const proof = await (options.mintTurnLease ?? turnLeaseMinter(env))({
        ...claims,
        action: "write",
        turnId: acquired.turnId,
        authorityLeaseId: acquired.leaseId,
        fencingToken: acquired.fencingToken,
        acquiredAt: acquired.acquiredAt,
        expiresAt: acquired.expiresAt,
      })
      const connectionCredential = subject === undefined ? undefined : options.turnCredentials?.mint({
        sessionId: acquired.sessionId,
        leaseId: acquired.leaseId,
        expiresAt: acquired.expiresAt,
        subject,
        orgId: claims.orgId,
      })
      return context.json({
        ...acquired,
        leaseId: proof.lease,
        expiresAt: proof.expiresAt,
        ...(connectionCredential ? { connectionCredential } : {}),
      })
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
      const connectionCredential = options.turnCredentials?.extendLease(ownedTurn!.authorityLeaseId, {
        leaseId: renewed.leaseId,
        expiresAt: renewed.expiresAt,
      })
      return context.json({
        ...renewed,
        leaseId: proof.lease,
        expiresAt: proof.expiresAt,
        ...(connectionCredential ? { connectionCredential } : {}),
      })
    }
    const released = await options.turnAuthority.releaseSessionTurn(owned)
    options.turnCredentials?.revokeLease(ownedTurn!.authorityLeaseId)
    return context.json(released)
  }

  const app = new Hono()
  const proofs = {
    authority: options.authority, verifyRelayProof: options.verifyRelayProof ?? relayProofVerifier(env),
    verifyTurnLease: options.verifyTurnLease ?? turnLeaseVerifier(env),
    turnLeaseDenial: (claims: TurnLeaseClaims) => proofDenial({ authority: options.authority, resolveWorkspaceOwner }, claims),
  }
  app.route("/", RuntimeSandboxSecretRoutes(options, proofs))
  if (options.sessionHostDelivery) app.route("/", SessionHostDeliveryRoutes({ ...options.sessionHostDelivery, ...proofs }))
  return app.post("/session-authorize", limitedBody, async (context) => {
    const body = await readJsonRecord(context.req.raw)
    if (body?.action === USAGE_REPORT_ACTION) return reportUsage(context, body)
    if (isHostAuthorityAction(body?.action)) return authorizeHost(context, body.action, body)
    const request = parseSessionAuthorityRequest(body)
    if (!request) {
      return context.json(
        {
          error: {
            code: "session_authority_request_invalid",
            message: "sessionId, action, and exact registration operation fields are required, and a registration or adoption names the runtime's session creation and update times",
          },
        },
        400,
      )
    }
    const { sessionId, action, operationId, reason, title, stream, parentSessionId, createdAt, updatedAt } = request
    const verified = await verifySessionProof(context, request)
    if (verified instanceof Response) return verified
    if (await sessionHostMismatch("turn" in verified ? verified.turn.claims : verified.claims, sessionId)) return sessionHostRefusal(context)

    try {
      if ("turn" in verified) {
        return await applyTurnAction(context, request, verified.turn.claims, verified.turn.ownedTurn, verified.turn.rechecked)
      }
      const { claims, relayScope, rechecked } = verified
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
        // relay, holding the owner's workspace-wide token for THIS request; a
        // lease outlives the token it was minted under and cannot carry this.
        if (claims.transport !== "relay-host" || relayScope?.sessionId !== undefined || sessionHostRootOf(claims.hostId)) {
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
          createdAt,
          updatedAt,
          ...(title ? { title } : {}),
        })
        return context.json({ allowed: true, adopted: adopted.adopted })
      }
      if (action === "start_status") {
        await options.authority.authorizeRuntimeSessionStartStatus({
          ...principal, workspaceId: claims.workspaceId, sessionId, registrationOperationId: operationId,
        })
        return context.json({ allowed: true })
      }
      if (action === "start") {
        await options.authority.authorizeRuntimeSessionStart({
          ...principal, workspaceId: claims.workspaceId, sessionId, registrationOperationId: operationId,
        })
        return context.json({ allowed: true })
      }
      if (action === "register") {
        const sessionHostRoot = claims.transport === "relay-host" ? sessionHostRootOf(claims.hostId) : undefined
        await options.authority.registerRuntimeSession({
          ...principal,
          operationId,
          sessionId,
          workspaceId: claims.workspaceId,
          createdAt,
          updatedAt,
          ...(title ? { title } : {}),
          ...(sessionHostRoot ? { sessionHostRoot } : {}),
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

      if (isTurnAction(action)) return await applyTurnAction(context, request, claims, undefined, rechecked)

      if (stream) {
        const decision = await authorizeRuntimeSessionStream(
          {
            authority: options.authority,
            ...(resolveWorkspaceOwner ? { resolveWorkspaceOwner } : {}),
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
      const answer = sessionAuthorityErrorAnswer(error, action)
      return context.json(answer.body, answer.status)
    }
  })
}

function sessionHostRefusal(context: Context) {
  return context.json({ error: { code: "session_host_mismatch", message: "This session is served by another host" } }, 403)
}
