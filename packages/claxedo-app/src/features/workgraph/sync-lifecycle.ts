import { createEffect, createMemo, createSignal, onCleanup, onMount, type Accessor } from "solid-js"
import { readAllChangeCursorPosition } from "@claxedo/workgraph/contracts"
import { WorkGraphApiError } from "./api"
import { useClaxedoEventsOptional } from "./app-ports"
import type { WorkgraphChangedEvent } from "./workgraph-changed-event"

// Trailing debounce for the `workgraph.changed` doorbell. The SERVER already
// coalesces a burst of commits into one nudge (~100ms trailing, non-resetting),
// so this window is not defending against churn — it only folds the handful of
// nudges that legitimately describe one logical burst (e.g. a command's own
// commit plus the reconciler tick) into a single revalidation.
export const WORKGRAPH_RELOAD_DEBOUNCE_MS = 100
export const WORKGRAPH_POLL_FALLBACK_MS = 60_000
export const WORKGRAPH_CURSOR_SKEW_TOLERANCE_MS = 5_000

/**
 * The subset of the central Claxedo events bus WorkGraph consumes. Declared
 * structurally so the feature never imports the shell's provider (see
 * `app-ports.ts`), and so tests can hand in a bus they drive by hand.
 */
export type WorkGraphEventsApi = {
  on: (type: "workgraph.changed", handler: (event: WorkgraphChangedEvent) => void) => () => void
  /**
   * Connectedness of the CENTRAL stream specifically — NOT the shell's aggregate
   * "any stream is up" signal. `workgraph.changed` rides the central bus only, so
   * the central stream's `false → true` edge is the one that means "a nudge may
   * have been missed while it was down". The aggregate is an OR across the
   * central stream and every remote workspace relay stream: with a remote
   * workspace open it stays true through a central drop/recover, the edge never
   * fires, and the missed nudge is never recovered (silent staleness, violating
   * R4). See `app/connection/stream-connectivity.ts`.
   */
  centralConnected: () => boolean
}

/**
 * WorkGraph's live-sync lifecycle: doorbell + revalidate.
 *
 * The canonical snapshot + Attention are re-read whenever the server rings the
 * `workgraph.changed` doorbell on the central events stream, debounced-trailing.
 * WorkGraph holds ZERO sockets of its own — the cursored `/changes` long-poll
 * (and with it the entire client cursor machinery) is gone.
 *
 * Because a nudge can be missed while the stream is down, currency is ALSO
 * re-established unconditionally — no cursor, no diffing — at each of the three
 * rare moments where it could have drifted: route activation, tab → visible, and
 * events-stream reconnect. The snapshot is small and these are infrequent.
 *
 * R4 (never SILENTLY stale) is preserved exactly as before: a failed reload does
 * not retry itself and does not fall back to stale data — it surfaces the error
 * verbatim and STALLS, ignoring further nudges until an explicit, user-initiated
 * `retry()`. `reload()` is idempotent and serialized, so duplicate nudges for one
 * logical burst cost at most one extra pass.
 */
export function useWorkGraphSyncLifecycle(input: {
  active: Accessor<boolean>
  /** Reloads the canonical snapshot and Attention together. Rejects to stall. */
  reload: () => Promise<unknown>
  /** Cursor from the latest fully applied snapshot. */
  snapshotCursor?: Accessor<string | undefined>
  /** Test seam; defaults to the shell's central bus (absent ⇒ revalidation only). */
  events?: WorkGraphEventsApi
  debounceMs?: number
  pollFallbackMs?: number
}) {
  const [error, setError] = createSignal<WorkGraphApiError>()
  const [documentVisible, setDocumentVisible] = createSignal(
    typeof document === "undefined" || document.visibilityState !== "hidden",
  )
  const events = input.events ?? (useClaxedoEventsOptional() as WorkGraphEventsApi | undefined)
  // The surface only syncs while it is the route the user is looking at: a
  // background tab or a hidden surface neither reloads nor listens, and earns its
  // one unconditional reload back when it returns.
  const live = createMemo(() => input.active() && documentVisible())

  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  let queued = false
  let disposed = false
  let lastApplied = cursorWatermark(input.snapshotCursor?.())

  const reloadNow = () => {
    if (disposed) return
    // Serialized: a nudge landing mid-reload queues exactly ONE follow-up pass
    // instead of stacking concurrent snapshot reads.
    if (inFlight) {
      queued = true
      return
    }
    inFlight = true
    void input.reload().then(
      () => {
        if (!disposed) {
          lastApplied = cursorWatermark(input.snapshotCursor?.()) ?? lastApplied
          setError(undefined)
        }
      },
      (failure: unknown) => {
        if (!disposed) setError(toApiError(failure))
      },
    ).finally(() => {
      inFlight = false
      const follow = queued
      queued = false
      // A stalled reload owns its own recovery through the banner's Retry — the
      // queued follow-up must not quietly paper over the error.
      if (follow && !disposed && !error()) reloadNow()
    })
  }

  const scheduleReload = () => {
    // Stalled: the banner is showing and Retry is the only way forward.
    if (disposed || error() || !live()) return
    if (debounceTimer) return
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      reloadNow()
    }, input.debounceMs ?? WORKGRAPH_RELOAD_DEBOUNCE_MS)
  }

  onMount(() => {
    if (typeof document === "undefined") return
    const updateVisibility = () => setDocumentVisible(document.visibilityState !== "hidden")
    document.addEventListener("visibilitychange", updateVisibility)
    onCleanup(() => document.removeEventListener("visibilitychange", updateVisibility))
  })

  onMount(() => {
    if (!events) return
    // No owner filter: WorkGraph is owner-scoped and the local central stream
    // carries exactly one owner's events, the envelope's `ownerUserId` is an
    // explicit routing HINT rather than an authorization boundary, and the reload
    // it triggers is authorized per-request by the snapshot endpoint anyway.
    onCleanup(events.on("workgraph.changed", (event) => {
      lastApplied = cursorWatermark(input.snapshotCursor?.()) ?? lastApplied
      const announced = cursorWatermark(event.cursor)
      if (
        announced !== undefined &&
        lastApplied !== undefined &&
        announced <= lastApplied - WORKGRAPH_CURSOR_SKEW_TOLERANCE_MS
      ) return
      scheduleReload()
    }))
  })

  // The resources load themselves on mount, so the surface is already current for
  // whatever `live` is at init — only LATER transitions have to catch up.
  let wasLive = input.active() && documentVisible()
  let wasConnected = events?.centralConnected() ?? false
  createEffect(() => {
    const nowLive = live()
    const nowConnected = events?.centralConnected() ?? false
    // Route activation / tab → visible, and events-stream reconnect (which may
    // have swallowed a nudge while it was down). Each reloads once, no cursor.
    const activated = nowLive && !wasLive
    const reconnected = nowLive && nowConnected && !wasConnected
    wasLive = nowLive
    wasConnected = nowConnected
    if (activated || reconnected) scheduleReload()
  })

  createEffect(() => {
    if (!live()) return
    const timer = setInterval(() => {
      scheduleReload()
    }, input.pollFallbackMs ?? WORKGRAPH_POLL_FALLBACK_MS)
    onCleanup(() => clearInterval(timer))
  })

  onCleanup(() => {
    disposed = true
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = undefined
  })

  return {
    error,
    retry: () => {
      setError(undefined)
      reloadNow()
    },
  }
}

function toApiError(error: unknown) {
  return error instanceof WorkGraphApiError
    ? error
    : new WorkGraphApiError("request_failed", error instanceof Error ? error.message : String(error))
}

function cursorWatermark(cursor: string | undefined) {
  if (!cursor) return
  try {
    return readAllChangeCursorPosition(cursor)
  } catch {
    return
  }
}
