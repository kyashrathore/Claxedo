import { cloneLocalSelectionState, type LocalSelectionState } from "../store/local-selection-handoff"

/**
 * Bounded, deliberate retry policy for the session-config selection PATCH.
 *
 * Background (the bug this replaces): session-selection's sync effect re-runs
 * whenever `sessionConfigRawQuery.isFetching` toggles during hydration. The old
 * `.catch(() => {})` swallowed PATCH failures while leaving the persisted dirty
 * flag set, so every `isFetching` toggle re-fired the same doomed PATCH —
 * accidental retry driven by query churn rather than an intentional policy.
 *
 * This scheduler makes the retry deliberate instead:
 *   - A failed PATCH is retried on an explicit backoff timer, not on churn.
 *   - After `maxAttempts` failures the cycle stops (`exhausted`); the caller
 *     keeps the persisted dirty flag so the write is never *silently* dropped —
 *     it is flushed again on the next mount, or re-armed by an explicit user
 *     selection / manual retry (`deliberate`).
 *   - `deliberate: false` calls (hydration churn) only advance an already-armed,
 *     idle attempt; they never resurrect an exhausted cycle nor fire duplicate
 *     concurrent PATCHes.
 *   - Single-flight per session is guaranteed even across a deliberate re-arm.
 */

export type SyncRetryTimer = { cancel: () => void }

export type SessionSyncRetryDeps = {
  /** Attempts to make before giving up on a permanently-failing PATCH. */
  maxAttempts: number
  /** Deliberate delay before the next retry. `failed` is the number of attempts already made. */
  backoffMs: (failed: number) => number
  /** True only while the session is an OpenCode scope that can accept a PATCH right now. */
  scopeReady: (session: string) => boolean
  /** Fire the actual PATCH. Resolves on success, rejects on failure. */
  patch: (session: string, state: LocalSelectionState) => Promise<unknown>
  /** Invoked once each time a PATCH resolves. */
  onSuccess: (session: string, state: LocalSelectionState) => void
  /** Invoked once when `maxAttempts` have failed. The dirty flag is intentionally kept by the caller. */
  onExhausted?: (session: string, state: LocalSelectionState) => void
  /** Injected timer so tests stay deterministic. */
  schedule: (fn: () => void, ms: number) => SyncRetryTimer
  /** Structural equality on selection state. Defaults to a JSON-clone comparison. */
  sameState?: (a: LocalSelectionState | undefined, b: LocalSelectionState | undefined) => boolean
}

export type SessionSyncRetry = {
  /**
   * Arm (or advance) a sync for `session`.
   * - `deliberate: true` — an explicit user selection or manual retry: reset the ledger and
   *   re-arm from attempt 0, even after exhaustion.
   * - `deliberate: false` (default) — hydration churn: create the ledger on first sight, re-arm
   *   only if the target state actually drifted, otherwise just advance an already-armed idle attempt.
   */
  arm: (session: string, state: LocalSelectionState, options?: { deliberate?: boolean }) => void
  /** True while a session still has a dirty selection the scheduler intends to persist. */
  pending: (session: string) => boolean
  /** True once a session's PATCH has permanently failed `maxAttempts` times. */
  exhausted: (session: string) => boolean
  /** Attempts fired so far for a session (test/observability aid). */
  attemptsFor: (session: string) => number
  /** Cancel all timers and drop every ledger (component cleanup). */
  dispose: () => void
}

type Entry = {
  state: LocalSelectionState
  attempts: number
  exhausted: boolean
  timer?: SyncRetryTimer
}

const defaultSameState = (a: LocalSelectionState | undefined, b: LocalSelectionState | undefined) =>
  JSON.stringify(cloneLocalSelectionState(a)) === JSON.stringify(cloneLocalSelectionState(b))

export function createSessionSyncRetry(deps: SessionSyncRetryDeps): SessionSyncRetry {
  const sameState = deps.sameState ?? defaultSameState
  const ledger = new Map<string, Entry>()
  // Single-flight guard that survives a deliberate re-arm (the network PATCH cannot be cancelled;
  // its outcome is ignored via the `sameState` guard below if the target state has since changed).
  const inflight = new Set<string>()

  const clear = (session: string) => {
    const entry = ledger.get(session)
    entry?.timer?.cancel()
    ledger.delete(session)
  }

  const run = (session: string) => {
    const entry = ledger.get(session)
    if (!entry || entry.exhausted || entry.timer) return
    if (inflight.has(session)) return
    if (!deps.scopeReady(session)) return

    const state = entry.state
    inflight.add(session)
    entry.attempts += 1

    deps
      .patch(session, state)
      .then(() => {
        deps.onSuccess(session, state)
        const current = ledger.get(session)
        if (current && sameState(current.state, state)) clear(session)
      })
      .catch(() => {
        const current = ledger.get(session)
        // Superseded by a newer selection while this PATCH was in flight — leave the new entry
        // alone; `finally` will kick it once the channel frees up.
        if (!current || !sameState(current.state, state)) return
        if (current.attempts >= deps.maxAttempts) {
          current.exhausted = true
          deps.onExhausted?.(session, state)
          return
        }
        current.timer = deps.schedule(() => {
          current.timer = undefined
          run(session)
        }, deps.backoffMs(current.attempts))
      })
      .finally(() => {
        inflight.delete(session)
        const current = ledger.get(session)
        if (current && !current.exhausted && !current.timer) run(session)
      })
  }

  const armFresh = (session: string, state: LocalSelectionState) => {
    ledger.set(session, { state, attempts: 0, exhausted: false })
    run(session)
  }

  const arm: SessionSyncRetry["arm"] = (session, state, options) => {
    const next = cloneLocalSelectionState(state)
    if (!next) return

    if (options?.deliberate) {
      clear(session)
      armFresh(session, next)
      return
    }

    const entry = ledger.get(session)
    if (!entry) {
      armFresh(session, next)
      return
    }
    if (!sameState(entry.state, next)) {
      // Target drifted without an explicit commit — re-arm from scratch.
      clear(session)
      armFresh(session, next)
      return
    }
    // Same-state churn: only advance an already-armed idle attempt (guarded inside `run`).
    run(session)
  }

  return {
    arm,
    pending: (session) => {
      const entry = ledger.get(session)
      return !!entry && !entry.exhausted
    },
    exhausted: (session) => !!ledger.get(session)?.exhausted,
    attemptsFor: (session) => ledger.get(session)?.attempts ?? 0,
    dispose: () => {
      for (const entry of ledger.values()) entry.timer?.cancel()
      ledger.clear()
      inflight.clear()
    },
  }
}
