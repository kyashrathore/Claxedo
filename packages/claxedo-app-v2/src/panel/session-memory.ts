import { createEffect, untrack, type Accessor } from "solid-js"
import type { WorkspacePanelNavigator } from "./workspace-tabs"

const MAX_SESSION_SNAPSHOTS = 64

export type SessionPanelSnapshot =
  | { readonly open: false }
  | { readonly open: true; readonly navigator: WorkspacePanelNavigator | null; readonly activeTabId: string }

export function rememberPanelPerSession(input: {
  readonly sessionId: Accessor<string | undefined>
  readonly snapshot: () => SessionPanelSnapshot
  readonly restore: (snapshot: SessionPanelSnapshot | undefined) => void
}): void {
  const snapshots = new Map<string, SessionPanelSnapshot>()
  const keep = (sessionId: string, snapshot: SessionPanelSnapshot) => {
    snapshots.delete(sessionId)
    snapshots.set(sessionId, snapshot)
    for (const oldest of snapshots.keys()) {
      if (snapshots.size <= MAX_SESSION_SNAPSHOTS) break
      snapshots.delete(oldest)
    }
  }
  createEffect((previous: string | undefined) => {
    const next = input.sessionId()
    if (next === previous) return next
    untrack(() => {
      if (previous) keep(previous, input.snapshot())
      if (!next) return
      const snapshot = snapshots.get(next)
      if (snapshot) keep(next, snapshot)
      input.restore(snapshot)
    })
    return next
  }, undefined)
}
