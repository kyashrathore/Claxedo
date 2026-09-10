/**
 * The rail shows sessions in two bands: the ones still in play, and the ones that have
 * gone quiet. A session's position inside a band never changes, so the list only moves
 * when a session crosses between them.
 *
 * Ordering by activity is what made the list move under the reader — "as soon as i click
 * second session it moves to first, feels like auto jumped back this is very bad" — and
 * ordering by the reader's last message only trades agent churn for their own, since
 * alternating between two sessions then swaps the top two rows every time. So neither
 * drives position. `createdAt` does, and it never changes: the runtime writes it once and
 * its upsert never updates the column.
 *
 * The band comes from `lastHumanTurnAt`, which the runtime records only when the turn's
 * `actorKind` is `human`. A wake, a subagent, a channel message or a scheduled run starts
 * a turn the same way the reader does and advances `updatedAt` with it, so `updatedAt`
 * cannot tell a session someone is working in from one the agents are working through on
 * their own. `actorKind` comes from the request's auth claims, so it cannot be forged.
 *
 * Staleness is recomputed from the clock on every read. There is deliberately no timer:
 * a deadline scheduled hours out is lost to a reload, a sleeping machine or a throttled
 * background tab, and the band would then be wrong until something unrelated poked it.
 * For the same reason there is no age-based *settling* either — sessions worked on
 * together go quiet together, so a threshold applied as an event would move several rows
 * at once, while applied as a predicate it just moves the divider.
 */

export const STALE_AFTER_MS = 2 * 60 * 60 * 1000

export type BandableSession = {
  id: string
  createdAt?: number
  /** Absent for a session only agents have driven, and for one predating the field. */
  lastHumanTurnAt?: number
}

export type BandInputs = {
  now: number
  staleAfterMs?: number
}

/**
 * A session nobody has ever spoken to is stale: no human turn is the strongest form of
 * "the reader has not been here", not an exemption from the question.
 */
export function isStaleSession(session: BandableSession, input: BandInputs) {
  const spokenAt = session.lastHumanTurnAt
  if (spokenAt === undefined) return true
  return input.now - spokenAt > (input.staleAfterMs ?? STALE_AFTER_MS)
}

function byNewestFirst(a: BandableSession, b: BandableSession) {
  return (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.id.localeCompare(b.id)
}

/**
 * Both bands carry the same order, so a session that goes quiet keeps every row created
 * after it above and every row created before it below — it passes only the rows that
 * went quiet before it did. The newest session crossing therefore costs no movement at
 * all, because it lands at the top of the band it just joined.
 */
export function splitSessionBands<Session extends BandableSession>(
  sessions: readonly Session[],
  input: BandInputs,
): { active: Session[]; settled: Session[] } {
  const active: Session[] = []
  const settled: Session[] = []
  for (const session of sessions) (isStaleSession(session, input) ? settled : active).push(session)
  return { active: active.sort(byNewestFirst), settled: settled.sort(byNewestFirst) }
}

/**
 * How long every row below the divider has been quiet, for its label. The *smallest*
 * staleness in the band is the only honest number: the band is ordered by creation, not
 * by staleness, so no single row's age describes the rest, but "at least this long" does.
 */
export function settledForMs(settled: readonly BandableSession[], input: BandInputs) {
  let newest: number | undefined
  for (const session of settled) {
    const spokenAt = session.lastHumanTurnAt
    if (spokenAt === undefined) continue
    if (newest === undefined || spokenAt > newest) newest = spokenAt
  }
  return newest === undefined ? undefined : Math.max(0, input.now - newest)
}

/**
 * The divider's label. Rounded down to whole hours, then days — the number says which
 * band you are looking at, not how long precisely, and a minute-accurate value would
 * change width as it ticked.
 */
export function quietForLabel(ms: number | undefined) {
  if (ms === undefined) return undefined
  const hours = Math.floor(ms / (60 * 60 * 1000))
  if (hours < 1) return "quiet"
  if (hours < 24) return `quiet for ${hours}h`
  return `quiet for ${Math.floor(hours / 24)}d`
}
