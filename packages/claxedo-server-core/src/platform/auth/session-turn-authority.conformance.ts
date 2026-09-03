import {
  SessionTurnConflictError,
  SessionTurnLeaseLostError,
  type SessionTurnAuthority,
} from "./session-turn-authority"
import type { PrivateSessionRuntimePrincipal } from "./private-session-authority"

export const SESSION_TURN_AUTHORITY_CONFORMANCE_SCENARIOS = [
  "atomic-session-exclusion",
  "idempotent-turn-retry",
  "reconstruction-visibility",
  "expiry-fencing-and-stale-release",
] as const

export type SessionTurnAuthorityConformanceHarness = {
  authority: SessionTurnAuthority
  /** A separately constructed adapter over the same durable backing store. */
  reconstructed: SessionTurnAuthority
  workspaceId: string
  sessionId: string
  actor: Extract<PrivateSessionRuntimePrincipal, { principalKind: "user" }>
  competitor: Extract<PrivateSessionRuntimePrincipal, { principalKind: "user" }>
  advancePast(expiresAt: number): void
}

export async function exerciseSessionTurnAuthorityConformance(
  harness: SessionTurnAuthorityConformanceHarness,
) {
  const base = {
    ...harness.actor,
    workspaceId: harness.workspaceId,
    sessionId: harness.sessionId,
    turnId: "msg_turn_1",
  } as const
  const first = await harness.authority.acquireSessionTurn(base)
  invariant(first.fencingToken >= 1, "the first durable turn has no fencing generation")
  invariant(first.expiresAt > first.acquiredAt, "the durable turn lease has no bounded lifetime")

  const retried = await harness.reconstructed.acquireSessionTurn(base)
  invariant(retried.leaseId === first.leaseId, "an exact retry created a second lease")
  invariant(retried.fencingToken === first.fencingToken, "an exact retry advanced the fence")

  const concurrent = await Promise.allSettled([
    harness.authority.acquireSessionTurn({ ...base, turnId: "msg_turn_2" }),
    harness.reconstructed.acquireSessionTurn({
      ...base,
      ...harness.competitor,
      turnId: "msg_turn_3",
    }),
  ])
  invariant(
    concurrent.every((result) => result.status === "rejected" && result.reason instanceof SessionTurnConflictError),
    "a concurrent or reconstructed authority admitted another active turn",
  )

  harness.advancePast(first.expiresAt)
  const replacement = await harness.reconstructed.acquireSessionTurn({ ...base, turnId: "msg_turn_2" })
  invariant(replacement.fencingToken > first.fencingToken, "expiry takeover did not advance the fence")
  invariant(replacement.leaseId !== first.leaseId, "expiry takeover reused the stale ownership secret")

  const staleRelease = await harness.authority.releaseSessionTurn({ ...base, ...first })
  invariant(!staleRelease.released, "a stale lease released its replacement")
  await rejects(
    () => harness.authority.renewSessionTurn({ ...base, ...first }),
    SessionTurnLeaseLostError,
    "a stale lease renewed after replacement",
  )

  const renewed = await harness.reconstructed.renewSessionTurn({ ...base, ...replacement })
  invariant(renewed.leaseId === replacement.leaseId, "renewal changed the ownership secret")
  invariant(renewed.fencingToken === replacement.fencingToken, "renewal advanced the fence")
  const released = await harness.reconstructed.releaseSessionTurn({ ...base, ...replacement })
  invariant(released.released, "the current owner could not release its lease")

  return {
    scenarios: SESSION_TURN_AUTHORITY_CONFORMANCE_SCENARIOS,
    exclusion: { concurrentDenied: true, reconstructionDenied: true },
    retry: { idempotent: true },
    recovery: { expiryTakeover: true, staleReleaseFenced: true },
  } as const
}

async function rejects(
  operation: () => Promise<unknown>,
  expected: new (...args: never[]) => Error,
  message: string,
) {
  try {
    await operation()
  } catch (error) {
    invariant(error instanceof expected, message)
    return
  }
  throw new Error(message)
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Session-turn authority conformance failed: ${message}`)
}
