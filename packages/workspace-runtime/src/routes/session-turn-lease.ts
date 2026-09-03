import type {
  SessionAccessPolicy,
  SessionAccessPolicyInput,
  SessionTurnLeaseDecision,
  SessionTurnReleaseDecision,
} from "../session-access-policy"
import { SESSION_TURN_LEASE_TTL_MS } from "@claxedo/workspace-relay-protocol"

type Timer = ReturnType<typeof setTimeout>

function unref(timer: Timer) {
  ;(timer as Timer & { unref?: () => void }).unref?.()
}

export type ActiveSessionTurnLease = {
  signal: AbortSignal
  valid(): boolean
  lost(): boolean
  fencingToken(): number
  release(): Promise<SessionTurnReleaseDecision>
}

export type SessionTurnLeaseAcquisition =
  | { acquired: true; lease: ActiveSessionTurnLease }
  | { acquired: false; decision: Exclude<SessionTurnLeaseDecision, { allowed: true }> }

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
  onLost: () => Promise<void> | void
  now?: () => number
}): Promise<SessionTurnLeaseAcquisition> {
  const { policy } = input
  if (!policy.acquireTurn || !policy.renewTurn || !policy.releaseTurn) {
    return {
      acquired: false,
      decision: denied("session_turn_authority_unavailable", "Durable session turn authority is unavailable"),
    }
  }
  const acquired = await policy.acquireTurn({ ...input.access, turnId: input.turnId })
  if (!acquired.allowed) return { acquired: false, decision: acquired }
  if (acquired.turnId !== input.turnId || acquired.expiresAt <= (input.now ?? Date.now)()) {
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

  const clearTimers = () => {
    if (renewTimer) clearTimeout(renewTimer)
    if (expiryTimer) clearTimeout(expiryTimer)
    renewTimer = undefined
    expiryTimer = undefined
  }
  const lose = () => {
    if (closed || lossStarted) return
    lossStarted = true
    leaseLost = true
    clearTimers()
    controller.abort(new Error("Durable session turn lease was lost"))
    void Promise.resolve(input.onLost()).catch(() => {})
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
      void Promise.resolve(policy.renewTurn!({
        ...input.access,
        signal: controller.signal,
        turnId: current.turnId,
        leaseId: current.leaseId,
        fencingToken: current.fencingToken,
      })).then((renewed) => {
        if (
          !renewed.allowed
          || renewed.turnId !== current.turnId
          || renewed.fencingToken !== current.fencingToken
          || renewed.expiresAt <= now()
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
