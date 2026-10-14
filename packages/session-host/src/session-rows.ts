import type { SessionAccessPolicy } from "@claxedo/session-core"
import type { SessionRowsPublisher } from "@claxedo/server-core/session/publish/session-rows-publisher"

/**
 * The session host's row credential is its turn lease: each lease the
 * authority issues or renews becomes the publishing bearer, and when the turn
 * ends the row it left — its last human turn, its outcome, idle — is flushed
 * under that lease after the release that ends it. Between turns nothing of
 * the row moves, so no credential is needed.
 */
export function sessionRowsUnderTurnLease(
  policy: SessionAccessPolicy,
  input: { hostId: string; workspaceId: string; publisher: SessionRowsPublisher },
): SessionAccessPolicy {
  const acquire = policy.acquireTurn?.bind(policy)
  const renew = policy.renewTurn?.bind(policy)
  const endTurn = policy.endTurn?.bind(policy)
  if (!acquire || !renew) return policy
  const credential = (token: string) => input.publisher.credentialChanged({ hostId: input.hostId, token, workspaceIds: [input.workspaceId] })
  return {
    ...policy,
    async acquireTurn(turn) {
      const decision = await acquire(turn)
      if (decision.allowed) credential(decision.leaseId)
      return decision
    },
    async renewTurn(turn) {
      const decision = await renew(turn)
      if (decision.allowed) credential(decision.leaseId)
      return decision
    },
    async endTurn(turn) {
      try {
        await endTurn?.(turn)
      } finally {
        await input.publisher.flush()
      }
    },
  }
}
