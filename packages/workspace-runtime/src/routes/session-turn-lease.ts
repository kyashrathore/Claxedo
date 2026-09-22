import type {
  SessionAccessPolicy,
  SessionAccessPolicyInput,
  SessionTurnLeaseDecision,
  SessionTurnReleaseDecision,
} from "../session-access-policy"
import { SESSION_TURN_LEASE_TTL_MS } from "@claxedo/workspace-relay-protocol"
import { DEFAULT_RECOVERY_BUDGETS, type RecoveryOutcome } from "@claxedo/agent-runtime-contract"
import { errorMessage } from "@claxedo/helpers"

type Timer = ReturnType<typeof setTimeout>

function unref(timer: Timer) {
  ;(timer as Timer & { unref?: () => void }).unref?.()
}

/**
 * What containment produced for the turn this lease was revoked under. An
 * outcome that refuses, or an `onLost` that rejected or outran the graceful
 * cancel budget, is a cleanup obligation this host still owns: the fence stops
 * its writes, it does not stop the provider running tools.
 */
export type SessionTurnLeaseLossResult =
  | { at: number; outcome: RecoveryOutcome }
  | { at: number; error: string }

export type ActiveSessionTurnLease = {
  signal: AbortSignal
  valid(): boolean
  lost(): boolean
  fencingToken(): number
  lossResult(): SessionTurnLeaseLossResult | undefined
  connectionCredential(): string | undefined
  release(): Promise<SessionTurnReleaseDecision>
}

export type SessionTurnLeaseAcquisition =
  | { acquired: true; lease: ActiveSessionTurnLease }
  | { acquired: false; decision: Exclude<SessionTurnLeaseDecision, { allowed: true }> }

function validLease(lease: Extract<SessionTurnLeaseDecision, { allowed: true }>, turnId: string, now: number) {
  return lease.turnId === turnId
    && turnId.trim().length > 0
    && typeof lease.leaseId === "string" && lease.leaseId.trim().length > 0
    && Number.isSafeInteger(lease.fencingToken) && lease.fencingToken > 0
    && Number.isFinite(lease.acquiredAt) && lease.acquiredAt >= 0
    && Number.isFinite(lease.expiresAt) && lease.expiresAt > lease.acquiredAt && lease.expiresAt > now
}

/**
 * Owns renewal and the local half of the durable fence. Expiry is scheduled
 * independently from the renewal request, so a stalled oracle cannot extend
 * execution past the last authority-confirmed deadline. `valid()` also checks
 * the wall clock synchronously before every runtime producer publication.
 */
export async function acquireSessionTurnLease(input: {
  policy: SessionAccessPolicy
  access: SessionAccessPolicyInput & { sessionId: string }
  turnId: string
  /** Proof for acquisition only; the lease itself is what renews and releases. */
  grant?: string
  onLost: () => Promise<RecoveryOutcome> | RecoveryOutcome
  now?: () => number
}): Promise<SessionTurnLeaseAcquisition> {
  const { policy } = input
  if (!policy.acquireTurn || !policy.renewTurn || !policy.releaseTurn) {
    return {
      acquired: false,
      decision: denied("session_turn_authority_unavailable", "Durable session turn authority is unavailable"),
    }
  }
  const acquired = await policy.acquireTurn({ ...input.access, turnId: input.turnId, ...(input.grant ? { grant: input.grant } : {}) })
  if (!acquired.allowed) return { acquired: false, decision: acquired }
  if (!validLease(acquired, input.turnId, (input.now ?? Date.now)())) {
    return {
      acquired: false,
      decision: denied("session_turn_authority_invalid_response", "Durable session turn authority returned an invalid lease"),
    }
  }

  const now = input.now ?? Date.now
  const controller = new AbortController()
  let current = acquired
  let localExpiresAt = Math.min(acquired.expiresAt, now() + SESSION_TURN_LEASE_TTL_MS)
  let closed = false
  let leaseLost = false
  let renewTimer: Timer | undefined
  let expiryTimer: Timer | undefined
  let lossStarted = false
  let lossResult: SessionTurnLeaseLossResult | undefined

  const clearTimers = () => {
    if (renewTimer) clearTimeout(renewTimer)
    if (expiryTimer) clearTimeout(expiryTimer)
    renewTimer = undefined
    expiryTimer = undefined
  }
  const recordLoss = (result: SessionTurnLeaseLossResult) => {
    lossResult ??= result
  }
  const lose = () => {
    if (closed || lossStarted) return
    lossStarted = true
    leaseLost = true
    clearTimers()
    controller.abort(new Error("Durable session turn lease was lost"))
    let timer: Timer | undefined
    const expired = new Promise<SessionTurnLeaseLossResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ at: now(), error: `Containing the lost turn exceeded ${DEFAULT_RECOVERY_BUDGETS.gracefulCancelMs}ms` }),
        DEFAULT_RECOVERY_BUDGETS.gracefulCancelMs,
      )
      unref(timer)
    })
    void (async () => {
      try {
        const attempted = Promise.resolve(input.onLost()).then(
          (outcome): SessionTurnLeaseLossResult => ({ at: now(), outcome }),
          (error): SessionTurnLeaseLossResult => ({ at: now(), error: errorMessage(error) }),
        )
        // A budget that expires first is what this lease keeps: the attempt is
        // detached, not cancelled, and the runtime holds the operation it
        // eventually settles. Letting a late success overwrite the record here
        // would rewrite a timed-out containment into one that worked.
        recordLoss(await Promise.race([attempted, expired]))
      } catch (error) {
        recordLoss({ at: now(), error: errorMessage(error) })
      } finally {
        if (timer) clearTimeout(timer)
      }
    })()
  }
  const stillValid = () => {
    if (closed || leaseLost) return false
    if (now() >= localExpiresAt) {
      lose()
      return false
    }
    return true
  }
  const schedule = () => {
    clearTimers()
    const remaining = localExpiresAt - now()
    if (remaining <= 0) {
      lose()
      return
    }
    expiryTimer = setTimeout(lose, remaining)
    unref(expiryTimer)
    const renewAfter = Math.max(25, Math.floor(remaining / 2))
    renewTimer = setTimeout(() => {
      if (!stillValid()) return
      void Promise.resolve().then(() => policy.renewTurn!({
        ...input.access,
        signal: controller.signal,
        turnId: current.turnId,
        leaseId: current.leaseId,
        fencingToken: current.fencingToken,
      })).then((renewed) => {
        if (!stillValid()) return
        if (
          !renewed.allowed
          || !validLease(renewed, current.turnId, now())
          || renewed.fencingToken !== current.fencingToken
        ) {
          lose()
          return
        }
        current = renewed
        localExpiresAt = Math.min(renewed.expiresAt, now() + SESSION_TURN_LEASE_TTL_MS)
        schedule()
      }, lose)
    }, renewAfter)
    unref(renewTimer)
  }
  schedule()

  return {
    acquired: true,
    lease: {
      signal: controller.signal,
      valid: stillValid,
      lost: () => leaseLost,
      fencingToken: () => current.fencingToken,
      lossResult: () => lossResult,
      connectionCredential: () => current.connectionCredential,
      async release() {
        if (closed) return { released: false }
        closed = true
        clearTimers()
        controller.abort()
        if (leaseLost) return { released: false }
        return await policy.releaseTurn!({
          ...input.access,
          turnId: current.turnId,
          leaseId: current.leaseId,
          fencingToken: current.fencingToken,
        })
      },
    },
  }
}

function denied(code: string, message: string): Exclude<SessionTurnLeaseDecision, { allowed: true }> {
  return { allowed: false, status: 503, code, message }
}
