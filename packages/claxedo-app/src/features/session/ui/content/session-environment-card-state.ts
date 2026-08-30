import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/platform/persistence/persist"

export type SessionEnvironmentCardPersist = {
  collapsedBySessionId: Record<string, boolean>
  recency: string[]
}

export type SessionEnvironmentCardState = {
  collapsed: (sessionId?: string) => boolean
  /** False until the persisted map has been read back — see below. */
  ready: () => boolean
  setCollapsed: (sessionId: string | undefined, collapsed: boolean) => void
  toggle: (sessionId?: string) => void
}

/**
 * How much of the shell's right gutter a painted card occupies. `undefined`
 * while no card is painted. The shell reserves the matching `padding-right` on
 * the timeline viewport and composer dock from this.
 */
export type SessionEnvironmentCardOccupancy = "expanded" | "collapsed"

export function migrateSessionEnvironmentCardPersist(value: unknown): SessionEnvironmentCardPersist {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { collapsedBySessionId: {}, recency: [] }
  }
  const record = value as Record<string, unknown>
  const byId = record.collapsedBySessionId
  if (byId && typeof byId === "object" && !Array.isArray(byId)) {
    const collapsedBySessionId: Record<string, boolean> = {}
    for (const [id, collapsed] of Object.entries(byId as Record<string, unknown>)) {
      if (typeof collapsed === "boolean") collapsedBySessionId[id] = collapsed
    }
    const recency = Array.isArray(record.recency)
      ? record.recency.filter((id): id is string => typeof id === "string")
      : Object.keys(collapsedBySessionId)
    return { collapsedBySessionId, recency }
  }
  // v1 was a single `{ collapsed: boolean }` that applied to every session.
  return { collapsedBySessionId: {}, recency: [] }
}

export const sessionEnvironmentCardCollapsePersist = {
  ...Persist.global("session.environment-card-collapsed.v2", ["session.environment-card-collapsed"]),
  migrate: migrateSessionEnvironmentCardPersist,
}

/** Same bound as per-session workspace-panel snapshots. */
export const MAX_SESSION_ENVIRONMENT_CARD_SNAPSHOTS = 64

/**
 * Gutter to reserve before the lazy card reports occupancy. Default COLLAPSED
 * so a first visit never resizes the transcript for a card the user did not
 * open. Once persist is ready, use that session's saved choice so an expanded
 * card does not snap the transcript from the collapsed rail to the full card.
 */
export function reservedSessionEnvironmentOccupancy(input: {
  visible: boolean
  ready: boolean
  collapsed: boolean
}): SessionEnvironmentCardOccupancy | undefined {
  if (!input.visible) return undefined
  if (!input.ready) return "collapsed"
  return input.collapsed ? "collapsed" : "expanded"
}

export function sessionEnvironmentCardCollapsed(persist: SessionEnvironmentCardPersist, sessionId: string | undefined) {
  if (!usableSessionId(sessionId)) return true
  return persist.collapsedBySessionId[sessionId] ?? true
}

export function withSessionEnvironmentCardCollapsed(
  persist: SessionEnvironmentCardPersist,
  sessionId: string,
  collapsed: boolean,
): SessionEnvironmentCardPersist {
  const recency = persist.recency.filter((id) => id !== sessionId)
  recency.push(sessionId)
  const collapsedBySessionId = { ...persist.collapsedBySessionId, [sessionId]: collapsed }
  while (recency.length > MAX_SESSION_ENVIRONMENT_CARD_SNAPSHOTS) {
    const oldest = recency.shift()
    if (oldest === undefined || oldest === sessionId) break
    delete collapsedBySessionId[oldest]
  }
  return { collapsedBySessionId, recency }
}

function usableSessionId(sessionId: string | undefined): sessionId is string {
  return !!sessionId && sessionId !== "new"
}

/** Route-restorable collapse preference, shared by the mount and its tests. */
export function createSessionEnvironmentCardState(): SessionEnvironmentCardState {
  // Default COLLAPSED per unknown session: a fresh session surface must not
  // resize the transcript for a card the user never asked to open. Each
  // session's persisted value wins once it resolves.
  const [ui, setUi, , ready] = persisted(
    sessionEnvironmentCardCollapsePersist,
    createStore<SessionEnvironmentCardPersist>({ collapsedBySessionId: {}, recency: [] }),
  )
  return {
    collapsed: (sessionId) => sessionEnvironmentCardCollapsed(ui, sessionId),
    ready,
    setCollapsed: (sessionId, collapsed) => {
      if (!usableSessionId(sessionId)) return
      setUi(withSessionEnvironmentCardCollapsed(ui, sessionId, collapsed))
    },
    toggle: (sessionId) => {
      if (!usableSessionId(sessionId)) return
      setUi(withSessionEnvironmentCardCollapsed(ui, sessionId, !sessionEnvironmentCardCollapsed(ui, sessionId)))
    },
  }
}

/**
 * ONE collapse store for the whole app, created outside any component owner.
 *
 * Desktop persistence is ASYNC (the store lives behind an Electron IPC store,
 * so `persisted()` hands back a Promise init). A per-mount store therefore
 * always renders the in-memory default first and only flips to the saved value
 * once the read resolves — which the user sees as the gutter jumping on every
 * fresh mount. Hoisting the store means that read happens ONCE per app run;
 * `ready` covers that first read. Collapse itself is keyed by session id so
 * expanding in one session cannot open the card in another.
 */
let sharedCardState: { state: SessionEnvironmentCardState; dispose: () => void } | undefined
export function sessionEnvironmentCardState(): SessionEnvironmentCardState {
  if (!sharedCardState) {
    sharedCardState = createRoot((dispose) => ({ state: createSessionEnvironmentCardState(), dispose }))
  }
  return sharedCardState.state
}

/** Test-only: drop the process-wide store so the next read picks up setPersisted. */
export function resetSessionEnvironmentCardStateForTests() {
  sharedCardState?.dispose()
  sharedCardState = undefined
}
