import type { Context } from "hono"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import { USAGE_REPORT_TAIL_MS } from "../usage/runtime-usage-report"
import { connectionTurnOwner } from "../connections/turn-owner"
import { deferredTurnGrantClaims, mintDeferredTurnGrant } from "./deferred-turn-grant"
import { sessionHostAdmits, type SessionHostPlacement } from "../authority/session-hosts"
import {
  proofHost,
  sessionLeasePrincipal,
  turnLeaseMinter,
  turnUsageProofMinter,
  type SessionProofClaims,
  type TurnLeaseClaims,
} from "./runtime-session-proofs"
import type { SessionAuthorityRequest } from "./runtime-authority-request"
import type { TurnDelivery } from "@claxedo/harness/contract"
import { assembleTurnDelivery, readTurnDelivery, turnDeliveryHolder, type TurnDeliveryHolder } from "../routes/session-host-delivery"
import type { RuntimeSessionAuthorityOptions } from "../routes/runtime-session-authority"

export type TurnAdmissionInput = {
  options: Pick<RuntimeSessionAuthorityOptions, "authority" | "turnAuthority" | "turnCredentials" | "sessionHostDelivery" | "mintTurnLease">
  env: Record<string, string | undefined>
  /** Why the proof's chain no longer stands: an inactive parent token, or an owner grant that no longer names the owner. */
  proofDenial(claims: SessionProofClaims): Promise<{ code: string; message: string } | undefined>
  sessionHostMismatch(claims: SessionProofClaims, placement: SessionHostPlacement | undefined): boolean
  sessionHostRefusal(context: Context): Response
}

/**
 * The turn actions of `/session-authorize`, over a proof `verifySessionProof`
 * has verified: `acquire` admits a turn, `apply` grants, renews and releases
 * one.
 */
export function createTurnAdmission(input: TurnAdmissionInput) {
  const { options, env } = input

  // Turn admission is reached only over a runtime's proof: the request
  // validation accepts a stream lease only together with `stream`, and
  // `stream` is only ever a read/write action.
  const embeddedTurnRefusal = (context: Context) => context.json(
    { error: { code: "session_turn_lease_invalid", message: "Session turn admission requires a Relay Host Token chain or an owner grant" } },
    401,
  )
  const turnAuthorityUnavailable = (context: Context) => context.json(
    { error: { code: "session_turn_authority_unavailable", message: "Durable session turn authority is not configured" } },
    503,
  )

  /**
   * One request admits a turn. The proof's chain, the host the session is
   * placed in and the owner whose accounts it spends are read together, since
   * each needs only the proof, and refused in the order the separate
   * questions were: the host, then the chain. Whether the actor may send an
   * agent turn on the session is the turn authority's own decision, made in
   * the statement that writes the lease, so no earlier read can be overtaken
   * by a revocation; a deferred grant proved it when it was minted and is
   * proved again as it is redeemed. For a session served by its own host the
   * turn's delivery is read beside the lease, so the host asks for nothing
   * more before it calls the model: every refusal the request can decide is
   * decided before the lease is taken, and one it cannot, a plugin read that
   * fails or a delivery that cannot be assembled, releases the lease it took
   * and hands out no credential.
   */
  async function acquireTurn(
    context: Context,
    request: Extract<SessionAuthorityRequest, { action: "turn_acquire" }>,
    claims: SessionProofClaims,
    rechecked: boolean,
    placement: Promise<SessionHostPlacement | undefined>,
  ) {
    const { sessionId, turnId } = request
    const principal = sessionLeasePrincipal(claims)
    if (claims.transport === "embedded") return embeddedTurnRefusal(context)
    const host = proofHost(claims)
    const delivering = options.sessionHostDelivery !== undefined && host !== undefined && host === sessionHostId(sessionId)
      ? options.sessionHostDelivery
      : undefined
    const wantsOwner = delivering !== undefined || options.turnCredentials !== undefined
    const resolveOwner = (workspaceId: string) => delivering
      ? delivering.resolveWorkspaceOwner(workspaceId)
      : options.authority.resolveWorkspaceOwner?.(workspaceId) ?? Promise.resolve(undefined)
    const [placed, denial, owner] = await Promise.all([
      placement,
      rechecked ? undefined : input.proofDenial(claims),
      wantsOwner ? resolveOwner(claims.workspaceId) : undefined,
    ])
    if (input.sessionHostMismatch(claims, placed)) return input.sessionHostRefusal(context)
    if (denial) return context.json({ error: denial }, 401)
    if (!options.turnAuthority) return turnAuthorityUnavailable(context)
    const subject = await connectionTurnOwner(options.turnCredentials, async () => owner, claims.workspaceId)
    const turn = { ...principal, sessionId, workspaceId: claims.workspaceId, turnId }
    let holder: TurnDeliveryHolder | undefined
    if (delivering) {
      if (!placed || !sessionHostAdmits(placed, { workspaceId: claims.workspaceId, sessionId })) return context.json({ error: { code: "turn_delivery_denied" } }, 403)
      const named = turnDeliveryHolder({ orgId: claims.orgId }, placed, owner)
      if ("code" in named) return context.json({ error: { code: named.code } }, named.status)
      holder = named
    }
    const reads = delivering && holder ? readTurnDelivery(delivering, claims.workspaceId, holder) : undefined
    reads?.catch(() => undefined)
    const acquired = await options.turnAuthority.acquireSessionTurn({
      ...turn,
      ...(claims.transport === "deferred-grant" ? { grantId: claims.grantId } : {}),
    })
    const release = () => options.turnAuthority!.releaseSessionTurn({ ...turn, leaseId: acquired.leaseId, fencingToken: acquired.fencingToken }).catch(() => undefined)
    let delivered: TurnDelivery | undefined
    try {
      const read = await reads
      if (read && "code" in read) {
        await release()
        return context.json({ error: { code: read.code } }, read.status)
      }
      delivered = read && delivering && placed
        ? await assembleTurnDelivery(delivering, read, { actorId: claims.actorId, workspaceId: claims.workspaceId, sessionId, expiresAt: acquired.expiresAt }, placed, new URL(context.req.url).origin)
        : undefined
    } catch (error) {
      await release()
      throw error
    }
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
      ...(delivered ? { delivery: delivered } : {}),
    })
  }

  async function applyTurnAction(
    context: Context,
    request: Exclude<SessionAuthorityRequest, { action: "turn_acquire" }>,
    claims: SessionProofClaims,
    ownedTurn: TurnLeaseClaims | undefined,
    rechecked: boolean,
  ) {
    const { sessionId, action, turnId } = request
    const principal = sessionLeasePrincipal(claims)
    if (claims.transport === "embedded") return embeddedTurnRefusal(context)
    const denial = rechecked ? undefined : await input.proofDenial(claims)
    if (denial) return context.json({ error: denial }, 401)
    if (!options.turnAuthority) return turnAuthorityUnavailable(context)
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
    const owned = {
      ...principal,
      sessionId,
      workspaceId: claims.workspaceId,
      turnId: turnId!,
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
    const usageProof = await turnUsageProofMinter(env)(ownedTurn!, Date.now() + USAGE_REPORT_TAIL_MS)
    return context.json({ ...released, usageProof: { proof: usageProof.lease, expiresAt: usageProof.expiresAt } })
  }

  return { acquire: acquireTurn, apply: applyTurnAction }
}
