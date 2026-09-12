import type { VirtualItem } from "@tanstack/solid-virtual"
import type {
  AgentAssistantMessage as AssistantMessage,
  AgentContentPart as Part,
} from "@claxedo/agent-runtime-contract"
import { sessionPrefetchPages, type SessionPrefetchPage } from "@/platform/sync/session-prefetch"
import { sessionViewKey } from "@/platform/identity/session-view-key"
import { firstFoldSessionPrefetch } from "../store/first-fold-prefetch"
import { Timeline } from "./message-timeline.data"
import type { TimelineRow } from "./timeline-row-model"

export type TimelineMountSnapshot = {
  measurements: VirtualItem[]
  toolOpen: Record<string, boolean | undefined>
  groupOpen: Record<string, boolean | undefined>
  /**
   * Foldable groups per turn, keyed by user message. A visit that rendered the
   * turn contributes the count it rendered; a session opened for the first time
   * takes it from the page its first-fold seed measured. Absent only when
   * neither exists, and the mount then decides the fold from the messages it
   * holds.
   */
  turnFoldableCounts?: Record<string, number | undefined>
}

const snapshots = new Map<string, TimelineMountSnapshot>()
// Remounting without a snapshot re-estimates heights and visibly shifts; 16 thrashed.
const MAX_SESSIONS = 64

export function readTimelineMountSnapshot(sessionKey: string): TimelineMountSnapshot | undefined {
  const snapshot = snapshots.get(sessionKey)
  const seeded = seededTurnFoldableCounts(sessionKey)
  if (!seeded) return snapshot
  return {
    measurements: [],
    toolOpen: {},
    groupOpen: {},
    ...snapshot,
    // A rendered count is the turn as the reader last saw it, so it wins over
    // the seed's floor for the turns it covers.
    turnFoldableCounts: { ...seeded, ...snapshot?.turnFoldableCounts },
  }
}

export function writeTimelineMountSnapshot(
  sessionKey: string,
  input: Omit<TimelineMountSnapshot, "turnFoldableCounts"> & { rows?: readonly TimelineRow.TimelineRow[] },
) {
  const { rows, ...snapshot } = input
  const previous = snapshots.get(sessionKey)
  snapshots.delete(sessionKey)
  // A turn that scrolled out of the rendered window contributes no fold row, so
  // merging keeps the count it had rather than dropping it on this unmount.
  snapshots.set(
    sessionKey,
    rows
      ? { ...snapshot, turnFoldableCounts: { ...previous?.turnFoldableCounts, ...turnFoldableCounts(rows) } }
      : snapshot,
  )
  while (snapshots.size > MAX_SESSIONS) snapshots.delete(snapshots.keys().next().value!)
}

/**
 * The count behind each fold row the visit put on screen. It is the one fold
 * input a switched-to session cannot recover from its own first surface, which
 * carries a turn's owning user message and its tail assistant message only.
 */
function turnFoldableCounts(rows: readonly TimelineRow.TimelineRow[]) {
  const counts: Record<string, number> = {}
  for (const row of rows) {
    if (row._tag !== "TurnFold") continue
    counts[row.userMessageID] = row.foldCount
  }
  return counts
}

/**
 * The counts the prefetched page yields for the session this pane key
 * addresses. The page is the whole surface the first-fold seed measured,
 * including the messages it withholds from the conversation store for 900ms, so
 * a session being opened for the first time can still fold on its first paint.
 */
function seededTurnFoldableCounts(sessionKey: string) {
  for (const entry of sessionPrefetchPages()) {
    if (sessionViewKey({ directory: entry.directory, sessionId: entry.sessionID }) !== sessionKey) continue
    const page = firstFoldSessionPrefetch(entry)?.page
    if (!page) return undefined
    return pageTurnFoldableCounts(page)
  }
  return undefined
}

function pageTurnFoldableCounts(page: SessionPrefetchPage) {
  const parts = new Map(page.parts.map((row) => [row.id, row.part] as const))
  const byTurn = new Map<string, AssistantMessage[]>()
  for (const message of page.messages) {
    if (message.role !== "assistant") continue
    const turn = byTurn.get(message.parentID)
    if (turn) turn.push(message)
    else byTurn.set(message.parentID, [message])
  }
  const counts: Record<string, number> = {}
  for (const [userMessageID, assistantMessages] of byTurn) {
    const count = Timeline.turnFoldableGroupCount({
      assistantMessages,
      getMessageParts: (messageID) => parts.get(messageID) ?? emptyParts,
    })
    if (count > 0) counts[userMessageID] = count
  }
  return counts
}

const emptyParts: Part[] = []
