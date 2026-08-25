// Row time labels and the session-status batch bookkeeping, split from
// rail-sidebar.tsx: standalone helpers with no component state, extracted to
// keep the sidebar under its size-budget ceiling.
import {
  railSessionStatusBatchKey,
  type RailSessionStatusTarget,
  type RailSessionStatusTargetGroup,
} from "./rail-session-status-target"

export const SIDEBAR_SESSION_STATUS_FRESH_MS = 10_000

export function relativeTime(ts: number) {
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 10) return "now"
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo}mo`
  return `${Math.floor(mo / 12)}y`
}

export function sidebarRequestDebug(...args: unknown[]) {
  if (typeof localStorage === "undefined") return
  if (localStorage.getItem("claxedo.debug.sidebar-requests") !== "1") return
  console.debug("[claxedo:sidebar-requests]", ...args)
}

export type SidebarSessionStatusBatch = {
  updatedAt: number
  inFlight?: Promise<void>
  controller?: AbortController
}

export const sidebarSessionStatusBatches = new Map<string, SidebarSessionStatusBatch>()

/** Give a trusted foreground activation priority over every background rail batch. */
export function abortSidebarSessionStatusBatches() {
  for (const [key, entry] of sidebarSessionStatusBatches) {
    if (!entry.controller) continue
    entry.controller.abort()
    sidebarSessionStatusBatches.set(key, { updatedAt: entry.updatedAt })
  }
}

/**
 * Drop batch entries that can no longer affect a decision.
 *
 * The key is the directory plus EVERY session id in the group, so it changes
 * whenever the group's membership does — opening, closing or filtering a
 * session mints a brand new key and strands the old one. That makes this a map
 * of every session-set permutation the rail has ever shown, not one entry per
 * session, and each key is itself O(sessions) of concatenated ids. Nothing
 * removed from it, so it grew for the lifetime of the tab.
 *
 * An entry carries exactly two facts: `updatedAt`, read only as
 * `now - updatedAt < SIDEBAR_SESSION_STATUS_FRESH_MS`, and `inFlight`, a
 * de-dupe guard. Once an entry is past the freshness window and has no request
 * in flight, that comparison can only ever be false — the entry is inert, and
 * dropping it cannot change what the poll does. A permutation that reappears
 * simply refetches, which is what the stale entry would have caused anyway.
 */
export function pruneSidebarSessionStatusBatches(now = Date.now()) {
  for (const [key, entry] of sidebarSessionStatusBatches) {
    if (entry.inFlight) continue
    if (now - entry.updatedAt < SIDEBAR_SESSION_STATUS_FRESH_MS) continue
    sidebarSessionStatusBatches.delete(key)
  }
}

/**
 * An opaque-id activity notification cannot identify which workspace emitted
 * it. Invalidate every currently visible placement group containing that id;
 * each group is then refetched through its own placement-aware client.
 */
export function invalidateSidebarSessionStatusGroupsForSession(
  groups: readonly RailSessionStatusTargetGroup[],
  sessionID: string,
) {
  return dropSidebarSessionStatusBatches(
    groups.filter((group) => group.targets.some((target) => target.sessionID === sessionID)),
  )
}

/** Aborts and forgets each group's batch entry, so the next run refetches it. */
export function dropSidebarSessionStatusBatches(groups: readonly RailSessionStatusTargetGroup[]) {
  for (const group of groups) {
    const batchKey = railSessionStatusBatchKey(group)
    sidebarSessionStatusBatches.get(batchKey)?.controller?.abort()
    sidebarSessionStatusBatches.delete(batchKey)
  }
  return groups.length
}

/**
 * Hands the rail's directory-wide read to the canonical session-meta owner, for
 * the focused pane's row only.
 *
 * The rail fetches `/session/status` + `/permission` + `/question` for a whole
 * directory. The focused session pane needs exactly those three, and used to
 * re-issue them ~1.2s later during its own hydration; that second read wrote
 * the session's canonical entries for the first time, which notified this rail
 * as "activity changed" and cost a third batch. Publishing here makes the
 * pane's hydration a cache hit, so the boot-era triple happens once.
 *
 * Only the focused placement is published. These entries are keyed by session
 * id alone, which cannot distinguish two workspace placements of one session,
 * so a row that is not the focused pane's own placement must never be written
 * under that key.
 */
export function publishFocusedRailSessionMeta<TStatus, TPermission, TQuestion>(input: {
  focused: RailSessionStatusTarget | undefined
  group: RailSessionStatusTargetGroup
  statuses: Record<string, TStatus>
  permissions: TPermission[]
  questions: TQuestion[]
  apply: (payload: {
    sessionID: string
    status: Record<string, TStatus>
    permissions?: TPermission[]
    questions?: TQuestion[]
  }) => void
}) {
  const focused = input.focused
  if (!focused) return false
  if (!input.group.targets.some((target) => target.key === focused.key)) return false
  input.apply({
    sessionID: focused.sessionID,
    status: input.statuses,
    permissions: input.permissions,
    questions: input.questions,
  })
  return true
}

export function sameRequestIds(previous: { id: string }[] | undefined, next: { id: string }[]) {
  if (!previous || previous.length !== next.length) return false
  return previous.every((item, index) => item.id === next[index]?.id)
}
