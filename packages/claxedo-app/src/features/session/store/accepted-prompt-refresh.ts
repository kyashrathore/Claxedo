import { createSignal } from "solid-js"
import { idleSessionStatus } from "./session-store"
import type { SessionStatusDispatchEvent } from "./session-status-dispatcher"
import type { ConversationDirectory } from "../conversation/conversation-chat-client"

type SessionStatus = NonNullable<Extract<SessionStatusDispatchEvent, { type: "session.status" }>["status"]>

/**
 * A turn whose transcript this client accepted responsibility for completing.
 *
 * `turnId` is the user message id, which is what admission hands the caller and
 * what the coverage index is keyed on. One obligation per turn rather than one
 * request for the whole client: a newer turn starting is not evidence about an
 * older one, and the single global request this replaced was overwritten by the
 * next prompt, so the older turn's answer was never fetched at all.
 *
 * Obligations are an in-memory read-work index and do not survive a reload;
 * `reconstructTurnCoverage` rebuilds them from the transcript on mount.
 */
export type TurnCoverageObligation = {
  directory: ConversationDirectory
  sessionID: string
  turnId: string
  requestedAt: number
  /**
   * The mounted owner working this obligation now. A claim is an attempt, not
   * the obligation: releasing it leaves the work to be picked up again.
   */
  claimedBy?: object
}

export type TurnCoverageTarget = Pick<TurnCoverageObligation, "directory" | "sessionID" | "turnId">

/** One client scope: the session, in the directory it was opened under. */
export type TurnCoverageScope = Pick<TurnCoverageObligation, "directory" | "sessionID">

/**
 * Per client scope, so one busy session cannot crowd out every other one. The
 * oldest is dropped rather than the newest: `reconstructTurnCoverage` rebuilds a
 * range's obligations from the transcript when it is reopened, so an evicted
 * entry is recoverable, while dropping the newest would drop the turn the user
 * is looking at.
 */
export const MAX_OUTSTANDING_PER_SCOPE = 64

/**
 * Concurrent coverage reads one mounted owner may have in flight. Four keeps a
 * reopened history range from issuing a request per turn at once while still
 * overlapping the round trips.
 */
export const MAX_CONCURRENT_COVERAGE_READS = 4

const [obligations, setObligations] = createSignal<readonly TurnCoverageObligation[]>([])

function scopeKey(target: TurnCoverageScope) {
  return `${target.directory}\0${target.sessionID}`
}

function sameTurn(target: TurnCoverageTarget, entry: TurnCoverageObligation) {
  return target.directory === entry.directory
    && target.sessionID === entry.sessionID
    && target.turnId === entry.turnId
}

export function requestAcceptedPromptRefresh(input: TurnCoverageScope & { messageID: string }) {
  const target = { directory: input.directory, sessionID: input.sessionID, turnId: input.messageID }
  setObligations((current) => {
    if (current.some((entry) => sameTurn(target, entry))) return current
    const next = [...current, { ...target, requestedAt: Date.now() }]
    const scope = scopeKey(target)
    const inScope = next.filter((entry) => scopeKey(entry) === scope)
    if (inScope.length <= MAX_OUTSTANDING_PER_SCOPE) return next
    const evicted = new Set(inScope.slice(0, inScope.length - MAX_OUTSTANDING_PER_SCOPE))
    return next.filter((entry) => !evicted.has(entry))
  })
}

/** Every turn this client still owes a complete transcript for. */
export function outstandingTurnCoverage(scope?: TurnCoverageScope) {
  const all = obligations()
  if (!scope) return all
  return all.filter((entry) => entry.directory === scope.directory && entry.sessionID === scope.sessionID)
}

export function hasOutstandingTurnCoverage(turnId: string) {
  return obligations().some((entry) => entry.turnId === turnId)
}

/**
 * Whether an owner is reading this turn's coverage right now.
 *
 * Distinct from merely owing it: a range reopened after a reload owes coverage
 * for every turn whose reply this client cannot see, which is not the same as
 * a turn that is settling. A transcript row that reads the first as the second
 * shows a finished turn as still working.
 */
export function turnCoverageInFlight(turnId: string) {
  return obligations().some((entry) => entry.turnId === turnId && entry.claimedBy !== undefined)
}

/**
 * Take over working one obligation. A second mounted owner is refused rather
 * than queued: both would issue the same read and apply the same page.
 */
export function claimTurnCoverage(target: TurnCoverageTarget, owner: object) {
  const found = obligations().find((entry) => sameTurn(target, entry))
  if (!found || (found.claimedBy !== undefined && found.claimedBy !== owner)) return false
  setObligations((current) =>
    current.map((entry) => (sameTurn(target, entry) ? { ...entry, claimedBy: owner } : entry)),
  )
  return true
}

/** Give up the attempt and keep the obligation, so a later mount can resume it. */
export function releaseTurnCoverage(target: TurnCoverageTarget, owner: object) {
  setObligations((current) =>
    current.map((entry) =>
      sameTurn(target, entry) && entry.claimedBy === owner ? { ...entry, claimedBy: undefined } : entry,
    ),
  )
}

/**
 * Discharge the obligation. Two things may do it: coverage for this very turn
 * applied, or the turn's owner answering that it can never be covered. A read
 * that ran out of attempts or came back short is neither.
 */
export function retireTurnCoverage(target: TurnCoverageTarget) {
  setObligations((current) => current.filter((entry) => !sameTurn(target, entry)))
}

/**
 * What a coverage page settles for the turn it was requested for.
 *
 * `unresolved` keeps the obligation: the transcript may still be merged, but
 * nothing about it says this turn is over. `unavailable` is only the owner's
 * own answer that the turn can never be covered.
 */
export type TurnCoverageAnswer = "complete" | "unavailable" | "unresolved"

/** The coverage envelope as this reader needs it, spelled without the producer's package. */
type CoveragePage = { turnId: string; coverage: "complete" | "partial" | "unavailable" }

/**
 * A page is evidence about the turn it names and no other. A latest-turn answer
 * for turn B arriving while turn A is owed would otherwise retire A's
 * obligation and merge B's window over it.
 */
export function readTurnCoverage(target: TurnCoverageTarget, page?: CoveragePage): {
  merge: boolean
  answer: TurnCoverageAnswer
} {
  if (!page || page.turnId !== target.turnId) return { merge: false, answer: "unresolved" }
  if (page.coverage === "unavailable") return { merge: false, answer: "unavailable" }
  // Only a complete page is merged. A partial one is a snapshot of a turn still
  // being written, and applying it over the window the live stream is filling
  // replaces newer rows with older ones; the stream is already delivering them.
  return { merge: page.coverage === "complete", answer: page.coverage === "complete" ? "complete" : "unresolved" }
}

/**
 * The turns of a loaded history range that are still owed a reply, newest
 * first and bounded by what one scope may hold.
 *
 * Obligations live only in this page's memory, so a reload leaves a turn whose
 * answer never arrived with nobody fetching it. The transcript is the evidence:
 * a user message whose assistant reply never landed is a turn this client still
 * owes coverage for, whoever asked for it and whenever.
 */
export function turnsAwaitingCoverage(
  userMessageIds: readonly string[],
  hasReply: (turnId: string) => boolean,
  limit = MAX_OUTSTANDING_PER_SCOPE,
): string[] {
  const awaiting: string[] = []
  for (let index = userMessageIds.length - 1; index >= 0 && awaiting.length < limit; index -= 1) {
    const turnId = userMessageIds[index]
    if (!hasReply(turnId)) awaiting.push(turnId)
  }
  return awaiting.reverse()
}

export function resetAcceptedPromptRefreshForTest() {
  setObligations([])
}

export function promptRefreshDelay(delay: number, signal?: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) return resolve(false)
    const timer = setTimeout(() => resolve(true), delay)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve(false)
    }, { once: true })
    return undefined
  })
}

export async function readAcceptedPromptStatus(input: {
  sessionID: string
  signal?: AbortSignal
  client: {
    session: {
      status: (
        parameters?: { directory?: string; workspace?: string },
        options?: { signal?: AbortSignal },
      ) => Promise<{ data?: Record<string, SessionStatus> }>
    }
  }
}) {
  const result = await input.client.session.status(undefined, { signal: input.signal }).catch(() => undefined)
  if (input.signal?.aborted) return undefined
  if (!result?.data) return undefined
  return result.data[input.sessionID] ?? idleSessionStatus
}
