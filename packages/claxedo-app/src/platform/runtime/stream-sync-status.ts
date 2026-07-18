// Reactive projection of the streaming connection lifecycle (T7).
//
// The pure FSM lives in `@/app/connection/stream-sync-lifecycle` (framework-
// agnostic, driven by bun:test with no Solid root). This platform module is the
// reactive seam that makes the same per-target lifecycle state legible to Solid
// UI, following the established single-writer-module pattern
// (`features/workspaces/data/workspace-connection.ts`: a `createStore` here,
// plain writer/reader functions exported, no context/provider indirection).
//
// It lives in `platform` — the shared lower layer, alongside
// `connection-placement.ts` which likewise models connection state — so both the
// writer (`app/integrations/claxedo-events.tsx`, via `stepLifecycle`) and the
// reader (`features/session/ui/components/session-connection-line.tsx`) can
// depend on it without an app<->features edge. The writer calls
// `reportStreamSyncLifecycle` on every lifecycle transition; components call
// `streamSyncLifecycleSnapshot` to read.
//
// `everLive` answers "has this stream EVER completed its first connect" — the
// derivation T7 needs to distinguish a fresh session's ordinary startup
// (idle → connecting, possibly retried, but never yet live) from a real drop
// after a healthy connection. A UI only needs to react once a stream has proven
// itself and then regressed.
import { createStore, produce } from "solid-js/store"
// Type-only edge to the pure FSM's state alphabet. platform never imports app
// VALUE symbols; a type-only import carries no runtime dependency and no import
// graph edge (see the AGENTS.md/layering guards, which exclude type-only
// specifiers).
import type { StreamSyncLifecycleState } from "@/app/connection/stream-sync-lifecycle"

/** One entry per `ClaxedoEventStreamTarget`: the shared control-plane stream, or a signed workspace's own stream. */
export type StreamSyncStreamId = "central" | `workspace:${string}`

export type StreamSyncSnapshot = {
  state: StreamSyncLifecycleState
  /** True once this stream has reached `"live"` at least once. */
  everLive: boolean
}

const [streamSyncSnapshots, setStreamSyncSnapshots] = createStore<Record<string, StreamSyncSnapshot>>({})

/** Single writer: called by the events provider on every lifecycle transition. */
export function reportStreamSyncLifecycle(id: StreamSyncStreamId, state: StreamSyncLifecycleState): void {
  setStreamSyncSnapshots(
    produce((snapshots) => {
      const previous = snapshots[id]
      snapshots[id] = {
        state,
        everLive: (previous?.everLive ?? false) || state === "live",
      }
    }),
  )
}

/** Reactive read accessor. Returns `undefined` before the stream has reported its first transition. */
export function streamSyncLifecycleSnapshot(id: StreamSyncStreamId): StreamSyncSnapshot | undefined {
  return streamSyncSnapshots[id]
}
