import type { Session, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { hasOpenSession } from "@/features/session/store/open-sessions"
import { cachedConversationBytes } from "@/features/session/conversation/conversation-memory-accounting"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { shellDataKeys } from "@/platform/sync/keys"
import { fastSessionSwitchAnyQuietDelay } from "@/platform/runtime/session-switch"
import { clearPromptSessionStatus, promptSessionStatusMeta } from "../../store/session-status-dispatcher"

export const SESSION_CACHE_LIMIT = 40

/**
 * Ceiling on TOTAL estimated transcript payload held across all cached sessions,
 * in `estimateConversationMemory` units.
 *
 * `SESSION_CACHE_LIMIT` bounds how MANY sessions are retained; it cannot bound
 * how much they weigh, and under mixed load that is the dimension that matters.
 * Measured with the app's own estimator on representative transcripts: ~677 B
 * per plain-text message and ~2.1 kB per tool-call message, so a 20k-message
 * tool-heavy session is ~39 MB on its own. Forty of those is ~1.6 GB — a count
 * cap alone lets a renderer die while every documented limit still reads green.
 *
 * 128 MiB holds roughly three maximal sessions, ten large ones, or a couple of
 * hundred ordinary ones. The estimator counts one byte per ASCII character and
 * ignores object headers, so real V8 retention runs well above this figure —
 * treat it as a conservative proxy, not an allocation budget.
 */
export const SESSION_CACHE_BYTE_BUDGET = 128 * 1024 * 1024
const SESSION_ACTIVITY_GRACE_MS = 30_000

function cachedDirectorySession(directory: string | undefined, sessionId: string) {
  if (!directory) return undefined
  return queryClient.getQueryData<{ session: Session[] }>(
    queryKeys.directory.sessionCache(directory),
  )?.session.find((item) => item.id === sessionId)
}

function recentlyActive(directory: string | undefined, sessionId: string) {
  const statusStarted = promptSessionStatusMeta(sessionId)?.started
  if (statusStarted && Date.now() - statusStarted < SESSION_ACTIVITY_GRACE_MS) return true
  const session = cachedDirectorySession(directory, sessionId)
  const sessionUpdated = session?.time?.updated ?? session?.time?.created
  if (!sessionUpdated) return false
  return Date.now() - sessionUpdated < SESSION_ACTIVITY_GRACE_MS
}

function shellSessionStatus(sessionId: string) {
  return queryClient.getQueryData<SessionStatus>(
    shellDataKeys.sessionId(sessionId, "status"),
  )
}

function removeSessionShellQueries(sessionID: string) {
  queryClient.removeQueries({ queryKey: shellDataKeys.sessionId(sessionID) })
}

const LIGHTWEIGHT_SESSION_METADATA = ["status", "requests"] as const

/**
 * A session surface is cache state materialised by opening/rendering a session.
 * Status and request rows are lightweight active-pane metadata and do not make
 * a session count as a retained render surface. The rail owns its bounded,
 * placement-aware inventory projection separately.
 */
export function isSessionSurfaceQueryKey(key: readonly unknown[]) {
  if (key[0] !== "shell" || key[1] !== "session") return false
  if (typeof key[2] !== "string" || !key[2] || key[2] === "new") return false
  return typeof key[3] === "string" && !LIGHTWEIGHT_SESSION_METADATA.includes(key[3] as "status" | "requests")
}

/**
 * Read-only benchmark/debug authority. The memory harness must ask the product
 * which query keys constitute a retained session surface; duplicating that
 * policy in an injected probe made lightweight rail metadata fail the heavy
 * surface ceiling and produced an asymmetric baseline/candidate comparison.
 */
if (typeof window !== "undefined") {
  ;(window as typeof window & {
    __claxedoSessionCachePolicy?: { isSurfaceQueryKey: typeof isSessionSurfaceQueryKey }
  }).__claxedoSessionCachePolicy = { isSurfaceQueryKey: isSessionSurfaceQueryKey }
}

function removeSessionSurfaceQueries(sessionID: string) {
  queryClient.removeQueries({
    queryKey: shellDataKeys.sessionId(sessionID),
    predicate: (query) => isSessionSurfaceQueryKey(query.queryKey),
  })
}

export function droppedSessionIDs(previous: Session[], next: Session[]) {
  const keep = new Set(next.map((item) => item.id))
  return previous.map((item) => item.id).filter((sessionId) => !keep.has(sessionId))
}

export function cleanupDroppedSessionCaches(
  previous: Session[],
  next: Session[],
  directory?: string,
) {
  const stale = droppedSessionIDs(previous, next).filter((sessionId) => {
    if (!directory) return true
    if (hasOpenSession(sessionId)) return false
    const status = shellSessionStatus(sessionId)
    if (status && status.type !== "idle" && recentlyActive(directory, sessionId)) return false
    return true
  })
  for (const sessionId of stale) {
    removeSessionShellQueries(sessionId)
    clearPromptSessionStatus(sessionId)
  }
}

export function cleanupSessionCaches(sessionId: string) {
  if (!sessionId) return
  removeSessionShellQueries(sessionId)
  clearPromptSessionStatus(sessionId)
}

/**
 * Session ids that currently hold shell caches, coldest first.
 *
 * Derived from the query cache rather than tracked in a module-level set: the
 * cache already knows both WHICH sessions it holds and WHEN each was last
 * written (`dataUpdatedAt`), so reading it is strictly more truthful than
 * parallel bookkeeping that can drift out of sync with the thing it describes
 * — and it keeps this module free of mutable module state.
 */
export function liveSessionSurfacesColdestFirst(): string[] {
  const newest = new Map<string, number>()
  for (const query of queryClient.getQueryCache().getAll()) {
    const key = query.queryKey
    if (!Array.isArray(key) || !isSessionSurfaceQueryKey(key)) continue
    const sessionId = key[2]
    if (typeof sessionId !== "string" || !sessionId) continue
    const at = query.state.dataUpdatedAt ?? 0
    newest.set(sessionId, Math.max(newest.get(sessionId) ?? 0, at))
  }
  return [...newest.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id)
}

/**
 * Enforce the ceilings on per-session shell caches (status/requests/todo/diff
 * and the conversation snapshot), keeping `sessionId` and dropping the coldest
 * until both `SESSION_CACHE_LIMIT` and `SESSION_CACHE_BYTE_BUDGET` hold.
 *
 * This is the ONLY size-based bound on that growth. `cleanupDroppedSessionCaches`
 * fires when the SERVER drops a session from its list, and `gcTime` is a
 * 30-minute wall clock that every refetch resets — neither reacts to how many
 * sessions the client has accumulated, nor to how large they are.
 * `SESSION_CACHE_LIMIT` and `pickSessionCacheEvictions` shipped in 2531335 with
 * ZERO callers anywhere in the tree and no tests: a written-down memory policy
 * that never ran. Wiring it is what makes the ceiling real, and it matters most
 * under mixed load — many sessions across several harnesses and workspaces,
 * where the two structures that ARE capped (10 workbench tabs, 32 conversation
 * clients) both spill their data into this uncapped one by design. Note that
 * both of those are also COUNT caps, which is why the byte budget has to live
 * here: evicting a `ChatClient` explicitly leaves its transcript in this cache.
 *
 * Two exemptions, both load-bearing:
 *  - OPEN sessions — a mounted tab must never lose the caches it renders from.
 *  - BUSY sessions — dropping status/requests mid-turn would strand a streaming
 *    session's UI, and a background turn is exactly the case a recency-ranked
 *    eviction would otherwise hit first.
 */
/**
 * The one pending accounting generation. The first dirty write fixes the
 * maintenance deadline; later writes only update the session protected from
 * eviction. A trailing debounce would starve the global ceiling forever while
 * any session streams deltas faster than the quiet delay.
 */
let pendingCeiling: { generation: number; sessionId: string; timer: ReturnType<typeof setTimeout> } | undefined
let ceilingGeneration = 0

/**
 * Run the ceiling once the renderer is idle.
 *
 * Sizing a transcript is a deep walk (~2 ms per MB), so a session whose
 * transcript is new to the cache costs real time to measure — ~26 ms for a
 * 20k-message session, and 3.3 s in the pathological case of forty large
 * transcripts arriving unmeasured. The canonical conversation snapshot write
 * is the right trigger and the wrong place to run: the user can still be waiting
 * on the pane that consumes it, and reclaiming memory is not required to paint.
 *
 * Deferring also makes the steady-state cost self-limiting. Sessions enter the
 * cache one authoritative write at a time, and writes coalesce into one pass, so each
 * pass finds at most one transcript it has not already measured; the rest are
 * served from the memo. The pathological figure above needs forty transcripts
 * to materialise between two passes, which no path in the app produces.
 */
export function scheduleSessionCacheCeiling(sessionId: string) {
  if (!sessionId || sessionId === "new") return
  if (pendingCeiling) {
    pendingCeiling.sessionId = sessionId
    return
  }
  const generation = ++ceilingGeneration
  const run = () => {
    if (pendingCeiling?.generation !== generation) return
    const target = pendingCeiling?.sessionId
    pendingCeiling = undefined
    if (target) enforceSessionCacheCeiling(target)
  }
  const idle = typeof globalThis.requestIdleCallback === "function"
    ? globalThis.requestIdleCallback
    : undefined
  const scheduleIdle = () => {
    if (pendingCeiling?.generation !== generation) return
    const interactionQuiet = fastSessionSwitchAnyQuietDelay({ baseDelay: 250 })
    if (interactionQuiet > 250) {
      const pending = pendingCeiling
      if (pending?.generation === generation) pending.timer = setTimeout(scheduleIdle, interactionQuiet)
      return
    }
    // Fall back rather than skip: an environment without
    // `requestIdleCallback` (Safari, test DOMs) still has to honour the memory
    // ceiling.
    if (idle) idle(run, { timeout: 2_000 })
    else setTimeout(run, 0)
  }
  // Memory accounting is maintenance, never a prerequisite for showing the
  // snapshot that triggered it. A minimum quiet period keeps the O(bytes) walk
  // out of the activation's presentation window; the idle callback then yields
  // again to any foreground work that arrived in the meantime.
  const timer = setTimeout(scheduleIdle, fastSessionSwitchAnyQuietDelay({ baseDelay: 250 }))
  pendingCeiling = { generation, sessionId, timer }
}

export function enforceSessionCacheCeiling(sessionId: string) {
  if (!sessionId || sessionId === "new") return []
  const coldestFirst = liveSessionSurfacesColdestFirst().filter((id) => id !== sessionId)
  const pinned = (id: string) => {
    if (hasOpenSession(id)) return true
    const status = shellSessionStatus(id)
    return !!status && status.type !== "idle"
  }
  // A session we cannot evict is sized from its last measurement. Sizing is a
  // deep walk, and the un-evictable sessions are exactly the ones whose
  // transcripts change constantly (a streaming turn writes on every delta), so
  // measuring them precisely would put a full re-walk on every session switch
  // to refine a number that changes no decision.
  const bytesFor = (id: string) => cachedConversationBytes(id, { allowStale: pinned(id) })
  const evicted = pickSessionCacheEvictions({
    coldestFirst,
    // The session being hydrated is never a candidate — evicting the caches the
    // caller is about to render from would blank the pane it just opened.
    retained: coldestFirst.length + 1,
    retainedBytes: coldestFirst.reduce((total, id) => total + bytesFor(id), 0) +
      cachedConversationBytes(sessionId, { allowStale: true }),
    pinned,
    bytesFor,
  })
  for (const id of evicted) {
    // Rail inventory status is placement-local and independently bounded. Once
    // a cold session surface is selected for eviction, retaining its old
    // session-ID-only status/request rows has no owner and grows by two entries
    // per visited session until the global 30-minute GC. Open and busy sessions
    // are pinned above, so removing the complete shell scope cannot blank a
    // mounted pane or strand a live turn.
    removeSessionShellQueries(id)
    clearPromptSessionStatus(id)
  }
  return evicted
}

/**
 * Coldest-first eviction until BOTH ceilings hold: at most `SESSION_CACHE_LIMIT`
 * cached sessions and at most `SESSION_CACHE_BYTE_BUDGET` of estimated transcript
 * payload.
 *
 * Two ceilings rather than one because they fail in opposite directions. Many
 * tiny sessions blow the count while weighing almost nothing; three enormous
 * ones blow the budget while the count still reads 3/40. Mixed load produces
 * both at once, which is exactly the case a single limit cannot express.
 *
 * `pinned` sessions (OPEN or BUSY) are skipped but still counted, so a pane full
 * of huge open sessions can legitimately sit above the byte budget. That is the
 * honest outcome: the alternative is blanking a mounted or streaming session to
 * satisfy a number. Eviction is lossless either way — transcripts persist per
 * session in IndexedDB (`conversation-persistence.ts`) and rehydrate on reopen.
 */
function pickSessionCacheEvictions(input: {
  coldestFirst: readonly string[]
  retained: number
  retainedBytes: number
  pinned: (sessionId: string) => boolean
  bytesFor: (sessionId: string) => number
}) {
  const stale = new Set<string>()
  let retained = input.retained
  let bytes = input.retainedBytes

  // Count pass: any cold session relieves count pressure, because each one
  // removed is exactly one fewer.
  for (const id of input.coldestFirst) {
    if (retained <= SESSION_CACHE_LIMIT) break
    if (input.pinned(id)) continue
    stale.add(id)
    retained -= 1
    bytes -= input.bytesFor(id)
  }

  // Byte pass: only a session that actually holds a transcript can relieve byte
  // pressure. Walking cold-first over ALL of them instead would evict every
  // weightless session before reaching the heavy one — freeing nothing, and
  // dropping exactly the cheap caches a user cycling between short sessions
  // depends on. One huge session must not cost the user their whole cache.
  for (const id of input.coldestFirst) {
    if (bytes <= SESSION_CACHE_BYTE_BUDGET) break
    if (stale.has(id) || input.pinned(id)) continue
    const weight = input.bytesFor(id)
    if (weight === 0) continue
    stale.add(id)
    retained -= 1
    bytes -= weight
  }
  return [...stale]
}
