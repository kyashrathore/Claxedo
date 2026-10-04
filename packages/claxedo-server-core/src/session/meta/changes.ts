/**
 * What the projection's writers report after a session row has landed:
 * one entry per session written or deleted under a workspace, or the
 * workspace alone when a snapshot rewrote its rows wholesale. Rows placed
 * in no workspace are nobody's to publish and are not reported.
 */
export type SessionMetaChange =
  | { kind: "changed"; workspaceId: string; sessionId: string }
  | { kind: "removed"; workspaceId: string; sessionId: string }
  | { kind: "workspace"; workspaceId: string }

type SessionMetaChangeListener = (change: SessionMetaChange) => void

const listeners = new Set<SessionMetaChangeListener>()

export function onSessionMetaChange(listener: SessionMetaChangeListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** After commit only. A listener that throws costs its own notice, never the write. */
export function reportSessionMetaChanges(changes: readonly SessionMetaChange[]) {
  for (const change of changes) {
    for (const listener of Array.from(listeners)) {
      try {
        listener(change)
      } catch (error) {
        console.warn("[session-meta] a change listener threw", { change, error: String(error) })
      }
    }
  }
}
