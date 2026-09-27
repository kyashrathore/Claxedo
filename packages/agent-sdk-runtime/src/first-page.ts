import {
  assistantMessageSettled,
  countFoldableGroups,
  foldedGroupKeys,
  groupParts,
  isGroupablePart,
  partHasText,
  turnFoldDecision,
  turnFoldShape,
  turnSegments,
  type PartGroup,
  type PartRef,
} from "@claxedo/agent-runtime-contract/turn-fold"
import type { AgentAssistantMessage, AgentContentPart, AgentMessage } from "@claxedo/agent-runtime-contract"

/** The most turns a first page carries, however short they are. */
export const FIRST_PAGE_TURN_CAP = 24

/** A first page stops taking turns once it holds this many bytes; the turn that crosses it is still sent whole. */
export const FIRST_PAGE_BYTE_CAP = 256 * 1024

const TURN_CHROME_LINES = 3
const FOLD_ROW_LINES = 2
const GROUP_ROW_LINES = 2
const FENCE_FRAME_LINES = 2
const USER_BUBBLE_SHARE = 0.8

/** What the reader's transcript can show: its viewport in body lines and columns, and whether it draws reasoning. */
export type FirstPageRequest = {
  rows: number
  cols: number
  reasoning: boolean
  /** The assistant message the session's last turn was cancelled at, which that turn draws as an interruption. */
  cancelledAssistantMessageId?: string
}

/**
 * One turn as a cold transcript draws it. A turn that folds is its user
 * message and every assistant envelope, each carrying only the parts the fold
 * leaves drawn, with `foldableCount` naming how many groups it hides; any
 * other turn is whole.
 */
export type FirstPageTurn = {
  messages: AgentMessage[]
  foldableCount?: number
  /** Pages back from this turn's user message; absent on a session's first turn. */
  cursor?: string
}

/** The newest turns of a session, oldest first; the first turn's cursor reads what comes before the page. */
export type FirstPage = { turns: FirstPageTurn[] }

/** One whole turn ending before `before` (the newest turn without it), and the cursor at its user message when older turns exist. */
export type TurnRead = (before?: string) => Promise<{ messages: AgentMessage[]; nextCursor?: string }> | { messages: AgentMessage[]; nextCursor?: string }

function isAssistant(message: AgentMessage): boolean {
  return message.info.role === "assistant"
}

function turnGroups(assistants: readonly AgentMessage[], reasoning: boolean, cancelledAssistantMessageId: string | undefined, compaction: boolean) {
  const partsById = new Map(assistants.map((message) => [message.info.id, message.parts] as const))
  const shape = turnFoldShape({
    assistantMessages: assistants.map((message) => message.info as AgentAssistantMessage),
    partsOf: (messageId) => partsById.get(messageId) ?? [],
    hasText: partHasText,
    showReasoning: reasoning,
    compaction,
    ...(cancelledAssistantMessageId === undefined ? {} : { cancelledAssistantMessageId }),
  })
  const partById = new Map(shape.refs.map((ref) => [ref.part.id, ref.part] as const))
  return { shape, groups: turnSegments(shape.refs, shape).flat(), part: (ref: PartRef) => partById.get(ref.partId) }
}

function groupMembers(group: PartGroup): PartRef[] {
  return group.type === "part" ? [group.ref] : group.refs
}

/** The turn a cold transcript draws: folded to the parts the fold leaves drawn when the contract's fold decision folds it, whole otherwise. */
export function firstPageTurn(messages: AgentMessage[], request: Pick<FirstPageRequest, "reasoning" | "cancelledAssistantMessageId">): FirstPageTurn {
  const [user, ...rest] = messages
  const assistants = rest.filter(isAssistant)
  const last = assistants.at(-1)
  if (!user || !last) return { messages }
  const compaction = user.parts.some((part) => part.type === "compaction")
  const { shape, groups, part } = turnGroups(assistants, request.reasoning, request.cancelledAssistantMessageId, compaction)
  const foldableCount = countFoldableGroups(groups, part)
  const decision = turnFoldDecision({
    foldableCount,
    settled: shape.settled,
    interrupted: shape.interruptedMessageIndex !== -1,
    errored: !!shape.errorMessage,
    busy: !assistantMessageSettled(last.info as AgentAssistantMessage),
  })
  if (!decision.folded) return { messages }
  const folded = foldedGroupKeys(decision, groups, part)
  const drawn = new Set(groups.filter((group) => !folded.has(group.key)).flatMap((group) => groupMembers(group).map((ref) => ref.partId)))
  return {
    messages: messages.map((message) => (isAssistant(message) ? { ...message, parts: message.parts.filter((item) => drawn.has(item.id)) } : message)),
    foldableCount,
  }
}

function wrappedLines(line: string, cols: number): number {
  return Math.max(1, Math.ceil(line.length / cols))
}

/** Body lines of markdown text: prose wraps at `cols`, a fenced line never wraps, a fence adds its frame, and a blank line takes none. */
function textLines(text: string, cols: number): number {
  let lines = 0
  let fenced = false
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      if (!fenced) lines += FENCE_FRAME_LINES
      fenced = !fenced
      continue
    }
    if (fenced) lines += 1
    else if (line.trim().length > 0) lines += wrappedLines(line, cols)
  }
  return lines
}

function promptText(user: AgentMessage): string {
  return user.parts.flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : [])).join("\n")
}

function drawnGroupLines(assistants: readonly AgentMessage[], cols: number): number {
  const items = assistants.flatMap((message) =>
    message.parts.filter((part) => isGroupablePart(part, partHasText, true)).map((part) => ({ messageId: message.info.id, part })),
  )
  const byId = new Map<string, AgentContentPart>(items.map((item) => [item.part.id, item.part]))
  return groupParts(items).reduce((lines, group) => {
    const only = group.type === "part" ? byId.get(group.ref.partId) : undefined
    return lines + (only?.type === "text" ? textLines(only.text, cols) : GROUP_ROW_LINES)
  }, 0)
}

/**
 * How many body lines a turn takes as the first page draws it at `cols`
 * columns: a fixed frame per turn, the prompt wrapped at the user bubble's
 * width, the fold row when it folds, a row per tool or reasoning group, and
 * every drawn text wrapped. It is an estimate for choosing how many turns to
 * send, never a layout.
 */
export function estimateTurnLines(turn: FirstPageTurn, cols: number): number {
  const [user, ...rest] = turn.messages
  if (!user) return 0
  const prompt = textLines(promptText(user), Math.max(1, Math.floor(cols * USER_BUBBLE_SHARE)))
  const fold = turn.foldableCount === undefined ? 0 : FOLD_ROW_LINES
  return TURN_CHROME_LINES + prompt + fold + drawnGroupLines(rest.filter(isAssistant), cols)
}

const encoder = new TextEncoder()

/**
 * The turns a cold transcript draws first, read one whole turn at a time from
 * the newest until their estimated lines cover the viewport and one more
 * screen, or the page reaches its turn or byte cap. The caps only decide how
 * many turns are sent; a message or part is never trimmed.
 */
export async function readFirstPage(read: TurnRead, request: FirstPageRequest): Promise<FirstPage> {
  const turns: FirstPageTurn[] = []
  const wanted = request.rows * 2
  let lines = 0
  let bytes = 0
  let before: string | undefined
  do {
    const page = await read(before)
    if (page.messages.length === 0) break
    const turn = firstPageTurn(page.messages, request)
    turns.unshift(page.nextCursor === undefined ? turn : { ...turn, cursor: page.nextCursor })
    lines += estimateTurnLines(turn, request.cols)
    bytes += encoder.encode(JSON.stringify(turn.messages)).byteLength
    before = page.nextCursor
  } while (before !== undefined && lines < wanted && turns.length < FIRST_PAGE_TURN_CAP && bytes < FIRST_PAGE_BYTE_CAP)
  return { turns }
}
