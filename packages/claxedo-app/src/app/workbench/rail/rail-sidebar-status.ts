import type { SessionStatus } from "@/features/session/data/sync/queries"
import {
  railSessionStatusBatchKey,
  type RailSessionStatusTarget,
  type RailSessionStatusTargetGroup,
} from "./rail-session-status-target"
import {
  dispatchSessionStatusEvent,
  promptSessionStatusMeta,
} from "@/features/session/store/session-status-dispatcher"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"

export const SIDEBAR_SESSION_STATUS_FRESH_MS = 10_000

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
  statuses?: Record<string, TStatus>
  permissions?: TPermission[]
  questions?: TQuestion[]
  apply: (payload: {
    sessionID: string
    status?: Record<string, TStatus>
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

function sessionStatusIsActive(status: SessionStatus | undefined) {
  return !!status && status.type !== "idle"
}

/**
 * Reject a batch poll that cannot have seen the turn the optimistic status
 * describes.
 *
 * `readStartedAt` is when the batch request was ISSUED. A read that started
 * before the optimistic dispatch answers a question asked before the turn
 * existed, so its idle is stale and must not clear the prediction. A read
 * issued after it did have the chance to observe the turn, so its answer —
 * idle included — retires the prediction; without that, a background row that
 * finished between two reads kept an optimistic busy the runtime had already
 * contradicted. Omitting `readStartedAt` cannot prove freshness and therefore
 * rejects, which is the pre-existing behaviour.
 */
export function shouldAcceptRailBatchStatus(
  sessionID: string,
  incoming: SessionStatus,
  readStartedAt?: number,
) {
  const meta = promptSessionStatusMeta(sessionID)
  if (meta?.source !== "optimistic") return true
  if (readStartedAt !== undefined && readStartedAt > meta.started) return true
  const cached = queryClient.getQueryData<SessionStatus>(shellDataKeys.sessionId(sessionID, "status"))
  if (!sessionStatusIsActive(cached)) return true
  return sessionStatusIsActive(incoming)
}

/** Push an unfocused row's batch read into the session-id cache so compact-switcher dots match the rail. */
export function syncUnfocusedRailBatchStatusToCache(input: {
  focusedSessionId?: string
  targets: readonly Pick<RailSessionStatusTarget, "sessionID">[]
  statuses?: Record<string, SessionStatus>
  readStartedAt?: number
}) {
  if (!input.statuses) return
  for (const target of input.targets) {
    if (target.sessionID === input.focusedSessionId) continue
    const status = input.statuses[target.sessionID] ?? { type: "idle" as const }
    if (!shouldAcceptRailBatchStatus(target.sessionID, status, input.readStartedAt)) continue
    const cached = queryClient.getQueryData<SessionStatus>(shellDataKeys.sessionId(target.sessionID, "status"))
    if (cached && JSON.stringify(cached) === JSON.stringify(status)) continue
    dispatchSessionStatusEvent({
      event: { type: "session.status", source: "server", sessionID: target.sessionID, status },
    })
  }
}

/**
 * Unwraps one leg of the rail's session-status batch, REJECTING when the read
 * failed instead of substituting an empty payload.
 *
 * The batch reads absence from a SUCCESSFUL response as an assertion: a session
 * missing from `/session/status` is idle, a row with no entry in `/permission`
 * has nothing pending. The SDK reports every non-2xx as `data: undefined`, so
 * defaulting to `{}`/`[]` handed that assertion a request that never reached
 * the runtime — an unreachable workspace reported all of its rows idle rather
 * than reporting nothing at all. Rejecting instead lets the batch's own `catch`
 * write nothing and leaves the freshness stamp untouched, so the next poll
 * retries rather than resting on a failure.
 */
export function railBatchData<T>(what: string) {
  return (result: { data?: T }): T => {
    if (result.data === undefined) throw new Error(`rail session status batch: ${what} unavailable`)
    return result.data
  }
}

export async function readRailBatchLeg<T>(
  what: string,
  request: Promise<{ data?: T }>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: railBatchData<T>(what)(await request) }
  } catch {
    return { ok: false }
  }
}

export function sameRequestIds(previous: { id: string }[] | undefined, next: { id: string }[]) {
  if (!previous || previous.length !== next.length) return false
  return previous.every((item, index) => item.id === next[index]?.id)
}

/**
 * Stamp each target with the START time of the batch read that just answered
 * for it. `railRowStatusType` compares this against an optimistic dispatch to
 * decide which of the two is the newer authority for a background row.
 */
export function stampRailStatusRead(
  current: Record<string, number | undefined>,
  targets: readonly Pick<RailSessionStatusTarget, "key">[],
  readStartedAt: number,
) {
  if (targets.every((target) => current[target.key] === readStartedAt)) return current
  const next = { ...current }
  for (const target of targets) next[target.key] = readStartedAt
  return next
}

export function mergeRailStatusRead(
  current: Record<string, string | undefined>,
  targets: readonly Pick<RailSessionStatusTarget, "key" | "sessionID">[],
  statuses: Record<string, { type?: string }>,
) {
  const updates = Object.fromEntries(targets.map((target) => [target.key, statuses[target.sessionID]?.type]))
  return Object.entries(updates).some(([key, value]) => current[key] !== value)
    ? { ...current, ...updates }
    : current
}

type RailRequests<P, Q> = Record<string, { permissions?: P[]; questions?: Q[] } | undefined>

export function mergeRailRequestRead<P extends { id: string; sessionID: string }, Q extends { id: string; sessionID: string }>(
  current: RailRequests<P, Q>,
  targets: readonly Pick<RailSessionStatusTarget, "key" | "sessionID">[],
  permissions?: P[],
  questions?: Q[],
) {
  const next = { ...current }
  let changed = false
  for (const target of targets) {
    const previous = current[target.key]
    const nextPermissions = permissions?.filter((item) => item.sessionID === target.sessionID)
    const nextQuestions = questions?.filter((item) => item.sessionID === target.sessionID)
    const permissionsChanged = nextPermissions !== undefined && !sameRequestIds(previous?.permissions, nextPermissions)
    const questionsChanged = nextQuestions !== undefined && !sameRequestIds(previous?.questions, nextQuestions)
    if (!permissionsChanged && !questionsChanged) continue
    const value = {
      ...previous,
      ...(nextPermissions !== undefined ? { permissions: nextPermissions } : {}),
      ...(nextQuestions !== undefined ? { questions: nextQuestions } : {}),
    }
    next[target.key] = value
    changed = true
  }
  return changed ? next : current
}
