import { latestTurnWindowNeedsTailSync } from "./first-fold-prefetch"
import { sessionHistoryKey } from "./history-pagination"

export type LatestTurnRead = { view: "latest-turn" } | { tail: true }

type RegisteredConversation = {
  messages: readonly { id: string; role: string }[]
  fragmentParts: ReadonlySet<string>
}

/** The canonical read of the latest turn, widened to the tail page when its window cannot prove the turn. */
export async function syncLatestTurnHistory(input: {
  conversation: () => RegisteredConversation
  read: (request: LatestTurnRead) => Promise<boolean>
}) {
  if (!await input.read({ view: "latest-turn" })) return false
  if (!latestTurnWindowNeedsTailSync(input.conversation().messages)) return true
  return input.read({ tail: true })
}

/**
 * A `latest-surface` page marks each assistant message it introduces as holding
 * fragment parts, and the timeline holds that turn behind a loader until a
 * canonical read lifts the mark. The activation's one canonical read has run
 * before any turn settles, so a reply this page is first to deliver (its live
 * `message.updated` never arrived) needs the latest-turn read here.
 */
export async function syncSettledTurnHistory(input: {
  conversation: () => RegisteredConversation
  readSurface: () => Promise<boolean>
  readLatestTurn: (request: LatestTurnRead) => Promise<boolean>
}) {
  if (!await input.readSurface()) return false
  if (!latestTurnHoldsFragmentParts(input.conversation())) return true
  return syncLatestTurnHistory({ conversation: input.conversation, read: input.readLatestTurn })
}

function latestTurnHoldsFragmentParts(conversation: RegisteredConversation) {
  const owningUser = conversation.messages.findLastIndex((message) => message.role === "user")
  return conversation.messages.slice(owningUser + 1).some((message) => conversation.fragmentParts.has(message.id))
}

export type ActiveTurnSnapshot = {
  key: string
  active: boolean
}

export function activeTurnTransition(input: {
  previous?: ActiveTurnSnapshot
  directory: string
  sessionID?: string
  active: boolean
}) {
  const key = input.sessionID && input.sessionID !== "new"
    ? sessionHistoryKey({ directory: input.directory, sessionID: input.sessionID })
    : undefined
  return {
    settled: !!key && input.previous?.key === key && input.previous.active && !input.active,
    next: key ? { key, active: input.active } : undefined,
  }
}
