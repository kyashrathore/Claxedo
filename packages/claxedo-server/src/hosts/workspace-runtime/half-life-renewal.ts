import { decodeJwt } from "jose"

export type RenewalTimers = {
  setTimeout(handler: () => void, ms: number): number
  clearTimeout(handle: number): void
}

/** The `exp` a control-plane-minted credential carries, read without verifying: the control plane verifies. */
export function expiryOf(token: string): number | undefined {
  try {
    const exp = decodeJwt(token).exp
    return typeof exp === "number" ? exp * 1_000 : undefined
  } catch {
    return undefined
  }
}

/** Node timers by number, unref'd so a pending renewal never holds the host process open. */
export function nodeRenewalTimers(): RenewalTimers {
  const handles = new Map<number, NodeJS.Timeout>()
  let next = 1
  return {
    setTimeout(handler, ms) {
      const id = next++
      const handle = setTimeout(() => {
        handles.delete(id)
        handler()
      }, ms)
      handle.unref()
      handles.set(id, handle)
      return id
    },
    clearTimeout(id) {
      const handle = handles.get(id)
      if (handle === undefined) return
      clearTimeout(handle)
      handles.delete(id)
    },
  }
}

export type RenewalOutcome =
  | Readonly<{ kind: "renewed"; expiresAt: number }>
  /** The control plane said no; asking again would get the same answer. */
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "failed" }>

const RETRY_INITIAL_MS = 2_000
const RETRY_CAP_MS = 60_000

/**
 * Keeps a runtime's control-plane credential alive by trading it at half its
 * life. A failed trade is retried with doubling backoff, capped at a minute,
 * until the held credential expires; a refusal ends the loop. An expired
 * credential is never traded, since the control plane renews only a live one,
 * so `lapsed` is the holder's cue that only a fresh delivery can restore it.
 */
export function halfLifeRenewal(input: {
  renew: () => Promise<RenewalOutcome>
  lapsed: () => void
  now: () => number
  timers: RenewalTimers
}) {
  let expiresAt: number | undefined
  let timer: number | undefined
  let retryMs = RETRY_INITIAL_MS
  let stopped = false

  const schedule = (ms: number) => {
    if (timer !== undefined) input.timers.clearTimeout(timer)
    timer = input.timers.setTimeout(() => {
      timer = undefined
      void attempt()
    }, Math.max(0, ms))
  }

  const attempt = async () => {
    const held = expiresAt
    if (stopped || held === undefined) return
    if (input.now() >= held) return input.lapsed()
    const outcome = await input.renew()
    if (stopped || held !== expiresAt) return
    if (outcome.kind === "renewed") return track(outcome.expiresAt)
    if (outcome.kind === "refused") return
    const remaining = held - input.now()
    if (remaining <= 0) return input.lapsed()
    schedule(Math.min(retryMs, remaining))
    retryMs = Math.min(retryMs * 2, RETRY_CAP_MS)
  }

  /** Follows a credential that expires at `next`, replacing whatever was followed before. */
  const track = (next: number) => {
    if (stopped) return
    expiresAt = next
    retryMs = RETRY_INITIAL_MS
    schedule((next - input.now()) / 2)
  }

  return {
    track,
    stop: () => {
      stopped = true
      if (timer !== undefined) input.timers.clearTimeout(timer)
      timer = undefined
    },
  }
}
