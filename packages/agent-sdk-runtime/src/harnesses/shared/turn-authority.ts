import type { AgentTurnOutcome } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeStoreCore, AgentRuntimeTurnFinishOutput } from "./runtime-store"

/**
 * Which owner a turn belongs to. The root runtime's own turns are finalized by
 * the runtime; these two domains run turns the runtime never admitted — a
 * provider-driven ACP Goal turn, and a subagent's child session — and each
 * needs an authority of its own rather than borrowing the parent's.
 */
export type TurnAuthorityDomain = "acp_goal" | "provider_child"

export type TurnAuthority = {
  domain: TurnAuthorityDomain
  sessionId: string
  assistantMessageId: string
  leaseId: string
  fencingToken?: number
}

export type TurnAuthorityStore = Pick<
  AgentRuntimeStoreCore,
  "acquireTurnLease" | "releaseTurnLease" | "finishTurn"
>

export class TurnAuthorityUnavailableError extends Error {
  readonly code = "turn_authority_unavailable"
  constructor(readonly domain: TurnAuthorityDomain, readonly sessionId: string) {
    super(`${domain} cannot project a turn for session ${sessionId}: another owner holds its turn lease`)
    this.name = "TurnAuthorityUnavailableError"
  }
}

/**
 * Claims the session's durable turn lease for this domain, and captures the
 * identity every later write must present.
 *
 * Capturing here rather than at finalization is the point: between a
 * projection starting and its terminal arriving, the session can be admitted
 * to a replacement turn, and an assistant message id alone cannot tell the two
 * apart. Returns nothing when the lease is already held, which the caller must
 * treat as a refusal to project: writing unfenced is exactly what the lease is
 * there to stop.
 */
export function registerTurnAuthority(
  store: TurnAuthorityStore,
  domain: TurnAuthorityDomain,
  identity: { sessionId: string; assistantMessageId: string; fencingToken?: number },
): TurnAuthority | undefined {
  const leaseId = store.acquireTurnLease(identity.sessionId)
  if (!leaseId) return undefined
  return {
    domain,
    sessionId: identity.sessionId,
    assistantMessageId: identity.assistantMessageId,
    leaseId,
    ...(identity.fencingToken === undefined ? {} : { fencingToken: identity.fencingToken }),
  }
}

/**
 * Finalizes through the captured identity and releases the lease.
 *
 * The store rejects a `leaseId` that is no longer the session's, so a
 * finalization that arrives after a replacement turn was admitted throws here
 * instead of ending somebody else's work. The release still runs: this
 * authority is finished either way, and holding a lease it can no longer use
 * would block the session forever.
 */
export function finalizeAuthoredTurn(
  store: TurnAuthorityStore,
  authority: TurnAuthority,
  outcome: AgentTurnOutcome,
): AgentRuntimeTurnFinishOutput {
  try {
    return store.finishTurn({
      sessionId: authority.sessionId,
      assistantMessageId: authority.assistantMessageId,
      outcome,
      leaseId: authority.leaseId,
      ...(authority.fencingToken === undefined ? {} : { fencingToken: authority.fencingToken }),
    })
  } finally {
    store.releaseTurnLease(authority.sessionId, authority.leaseId)
  }
}
