import type { SessionLifecycleEvent } from "../data/session-lifecycle"
import { markRolledBackDraft } from "./rolled-back-drafts"

// Backend-orchestrated session creation with lifecycle reconciliation.
//
// This flow requires the frontend to "subscribe
// first, perform the HTTP fetch, and reconcile events buffered during fetch."
// `createOpencodeSessionWithLifecycle` does exactly that for draft-backed
// creates: before the HTTP call fires, it begins listening for a matching
// `session.lifecycle` `created` event.
//
// Reconciliation contract (rubric C6/C7):
//
//   1. HTTP success + no lifecycle event       → return HTTP result.
//   2. HTTP success + lifecycle `failed` within
//      `recoveryGraceMs` of the HTTP completion → server wins, throw.
//   3. HTTP error   + lifecycle `created` for the
//      same draftId (any time inside the grace) → recover the session id.
//   4. HTTP error   + lifecycle `failed`         → throw the failed message
//                                                   instead of the HTTP error.
//   5. HTTP error   + nothing within grace       → throw the original error.
//
// Without rule (2) the wrapper would silently return success even when the
// backend just told us the create blew up. The "server wins" rule keeps the
// UI honest on slow networks where the response races the event stream.
// Canonical lifecycle envelope (rubric D4). The listener accepts the same
// shape the server publishes so this wrapper, the GlobalSync subscriber, and
// the ClaxedoEvents provider all reason about one type.
export type ClaxedoLifecycleListenerEvent = SessionLifecycleEvent

export type ClaxedoLifecycleListener = {
  on(
    type: "session.lifecycle",
    handler: (event: ClaxedoLifecycleListenerEvent) => void,
  ): () => void
}

export type CreateOpencodeSessionTarget = { id: string }

const DEFAULT_RECOVERY_GRACE_MS = 1500

export async function createOpencodeSessionWithLifecycle(input: {
  draftId?: string
  events?: ClaxedoLifecycleListener
  perform: () => Promise<CreateOpencodeSessionTarget>
  recoveryGraceMs?: number
}): Promise<CreateOpencodeSessionTarget> {
  if (!input.draftId || !input.events) return input.perform()

  let recovered: CreateOpencodeSessionTarget | undefined
  let failure: string | undefined
  let resolveRecovered: ((value: CreateOpencodeSessionTarget | undefined) => void) | undefined
  let resolveFailure: (() => void) | undefined
  const lifecyclePromise = new Promise<CreateOpencodeSessionTarget | undefined>((resolve) => {
    resolveRecovered = resolve
  })
  const failurePromise = new Promise<void>((resolve) => {
    resolveFailure = resolve
  })

  const unsubscribe = input.events.on("session.lifecycle", (event) => {
    if (event.draftId !== input.draftId) return
    if (event.phase === "created" && event.sessionID) {
      recovered = { id: event.sessionID }
      resolveRecovered?.(recovered)
      return
    }
    if (event.phase === "failed") {
      failure = event.message ?? "Session creation failed"
      resolveFailure?.()
    }
  })

  const grace = input.recoveryGraceMs ?? DEFAULT_RECOVERY_GRACE_MS

  try {
    const result = await input.perform()
    if (failure) {
      // Rubric C7: mark the draft as rolled back so a late `created` event
      // arriving after this throw doesn't insert a phantom session row via
      // the GlobalSync subscriber.
      if (input.draftId) markRolledBackDraft(input.draftId)
      throw new Error(failure)
    }
    // Rubric C6: server wins. HTTP returned 2xx but the backend may still
    // emit a `failed` event within the grace window (slow event stream or
    // event scheduled before the HTTP response flushed). Wait briefly for
    // a `failed` to arrive; if it does, surface the failure instead of
    // pretending the create succeeded.
    const failureRace = await Promise.race([
      failurePromise.then(() => "failed" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), grace)),
    ])
    if (failureRace === "failed" && failure) {
      if (input.draftId) markRolledBackDraft(input.draftId)
      throw new Error(failure)
    }
    return result
  } catch (err) {
    if (recovered) return recovered
    const settled = await Promise.race([
      lifecyclePromise,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), grace)),
    ])
    if (settled) return settled
    if (input.draftId) markRolledBackDraft(input.draftId)
    if (failure) throw new Error(failure)
    throw err
  } finally {
    unsubscribe()
  }
}
