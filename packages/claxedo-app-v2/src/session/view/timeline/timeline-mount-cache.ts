import type { VirtualItem } from "@tanstack/solid-virtual"
import type {
  AgentAssistantMessage as AssistantMessage,
  AgentContentPart as Part,
  AgentPresentationMessage as Message,
} from "@claxedo/agent-runtime-contract"
import { Timeline } from "./message-timeline.data"
import type { TimelineRow } from "./timeline-row-model"
import type { TimelineScrollPosition } from "./timeline-scroll-memory"

export type TimelineMountSnapshot = {
  scroll?: TimelineScrollPosition
  measurements: VirtualItem[]
  toolOpen: Record<string, boolean | undefined>
  groupOpen: Record<string, boolean | undefined>
  toolRevealed: Record<string, boolean | undefined>
  turnFoldableCounts?: Record<string, number | undefined>
}

const snapshots = new Map<string, TimelineMountSnapshot>()
const MAX_SESSIONS = 64

export function readTimelineMountSnapshot(
  sessionKey: string,
  seeded?: Record<string, number>,
): TimelineMountSnapshot | undefined {
  const snapshot = snapshots.get(sessionKey)
  if (!seeded) return snapshot
  return {
    measurements: [],
    toolOpen: {},
    groupOpen: {},
    toolRevealed: {},
    ...snapshot,
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
  snapshots.set(
    sessionKey,
    rows
      ? { ...snapshot, turnFoldableCounts: { ...previous?.turnFoldableCounts, ...turnFoldableCounts(rows) } }
      : snapshot,
  )
  while (snapshots.size > MAX_SESSIONS) snapshots.delete(snapshots.keys().next().value!)
}

function turnFoldableCounts(rows: readonly TimelineRow.TimelineRow[]) {
  const counts: Record<string, number> = {}
  for (const row of rows) {
    if (row._tag !== "TurnFold") continue
    counts[row.userMessageId] = row.foldCount
  }
  return counts
}

export function pageTurnFoldableCounts(page: {
  messages: readonly Message[]
  parts: ReadonlyArray<{ id: string; part: Part[] }>
}) {
  const parts = new Map(page.parts.map((row) => [row.id, row.part] as const))
  const byTurn = new Map<string, AssistantMessage[]>()
  for (const message of page.messages) {
    if (message.role !== "assistant") continue
    const turn = byTurn.get(message.parentID)
    if (turn) turn.push(message)
    else byTurn.set(message.parentID, [message])
  }
  const counts: Record<string, number> = {}
  for (const [userMessageId, assistantMessages] of byTurn) {
    const count = Timeline.turnFoldableGroupCount({
      assistantMessages,
      getMessageParts: (messageId) => parts.get(messageId) ?? emptyParts,
    })
    if (count > 0) counts[userMessageId] = count
  }
  return counts
}

const emptyParts: Part[] = []
