import {
  assistantMessageSettled,
  countFoldableGroups,
  foldedGroupKeys,
  groupMembers,
  groupParts,
  isGroupablePart,
  partHasText,
  turnFoldDecision,
  turnFoldShape,
  turnSegments,
  type PartRef,
} from "@claxedo/agent-runtime-contract/turn-fold"
import { toolOpensByDefault, toolPartHeader, type AgentAssistantMessage, type AgentContentPart, type AgentMessage } from "@claxedo/agent-runtime-contract"
import type { TurnOutline } from "./turn-outline"

export const TURN_PAGE_TURN_CAP = 24

export const TURN_PAGE_BYTE_CAP = 256 * 1024

const TURN_PAGE_FILL_SCREENS = 2

const TURN_CHROME_LINES = 3
const FOLD_ROW_LINES = 2
const GROUP_ROW_LINES = 2
const FENCE_FRAME_LINES = 2
const USER_BUBBLE_SHARE = 0.8

export type ReaderSettings = { reasoning: boolean; shell: boolean; edit: boolean }

export type TurnPageQuery = ReaderSettings & { rows: number; cols: number }

export type TurnPageRequest = TurnPageQuery & {
  /** The assistant message the session's last turn was cancelled at, which that turn draws as an interruption. */
  cancelledAssistantMessageId?: string
  /** Read the turns before this cursor; absent reads from the newest turn. */
  before?: string
}

export type PageTurn = {
  messages: AgentMessage[]
  /** Pages back from this turn's user message; absent on a session's first turn. */
  cursor?: string
}

/** Consecutive turns of a session, oldest first; the first turn's cursor reads what comes before the page. */
export type TurnPage = { turns: PageTurn[] }

export type FirstRead<Session> = { session: Session; outline: TurnOutline; page?: TurnPage }

const TURN_PAGE_MAX_EXTENT = 2000

/** A read named some but not all of its query parameters, or one of them out of range; every producer answers it with a 400. */
export class TurnPageQueryError extends Error {
  override readonly name = "TurnPageQueryError"
}

/** One whole turn ending before `before` (the newest turn without it), and the cursor at its user message when older turns exist. */
export type TurnRead = (before?: string) => Promise<{ messages: AgentMessage[]; nextCursor?: string }> | { messages: AgentMessage[]; nextCursor?: string }

type Query = (name: string) => string | undefined

function extent(query: Query, name: "rows" | "cols"): number {
  const value = query(name)
  if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > TURN_PAGE_MAX_EXTENT) {
    throw new TurnPageQueryError(`${name} must be an integer between 1 and ${TURN_PAGE_MAX_EXTENT}`)
  }
  return Number(value)
}

function settingOf(query: Query, name: keyof ReaderSettings): boolean {
  const value = query(name)
  if (value !== "0" && value !== "1") throw new TurnPageQueryError(`${name} must be 0 or 1`)
  return value === "1"
}

function parseReaderSettings(query: Query): ReaderSettings {
  return { reasoning: settingOf(query, "reasoning"), shell: settingOf(query, "shell"), edit: settingOf(query, "edit") }
}

const PAGE_QUERY_NAMES = ["rows", "cols", "reasoning", "shell", "edit"] as const

export function parseTurnPageQuery(query: Query): TurnPageQuery | undefined {
  if (PAGE_QUERY_NAMES.every((name) => query(name) === undefined)) return undefined
  return { ...parseReaderSettings(query), rows: extent(query, "rows"), cols: extent(query, "cols") }
}

export function parseOlderTurnPageQuery(query: Query): TurnPageQuery & { before: string } {
  const page = parseTurnPageQuery(query)
  if (!page) throw new TurnPageQueryError("a page read names rows, cols, reasoning, shell and edit")
  const before = query("before")
  if (!before) throw new TurnPageQueryError("before must be a non-empty cursor")
  return { ...page, before }
}

type AssistantEntry = AgentMessage & { info: AgentMessage["info"] & AgentAssistantMessage }

function isAssistant(message: AgentMessage): message is AssistantEntry {
  return message.info.role === "assistant"
}

function turnGroups(assistants: readonly AssistantEntry[], reasoning: boolean, cancelledAssistantMessageId: string | undefined, compaction: boolean) {
  const partsById = new Map(assistants.map((message) => [message.info.id, message.parts] as const))
  const shape = turnFoldShape({
    assistantMessages: assistants.map((message) => message.info),
    partsOf: (messageId) => partsById.get(messageId) ?? [],
    hasText: partHasText,
    showReasoning: reasoning,
    compaction,
    ...(cancelledAssistantMessageId === undefined ? {} : { cancelledAssistantMessageId }),
  })
  const partById = new Map(shape.refs.map((ref) => [ref.part.id, ref.part] as const))
  return { shape, groups: turnSegments(shape.refs, shape).flat(), part: (ref: PartRef) => partById.get(ref.partId) }
}

function headed(messages: readonly AgentMessage[], settings: ReaderSettings): AgentMessage[] {
  const part = (item: AgentContentPart) => (item.type === "tool" && !toolOpensByDefault(item.tool, settings) ? toolPartHeader(item) : item)
  return messages.map((message) => ({ ...message, parts: message.parts.map(part) }))
}

export function projectTurn(messages: AgentMessage[], settings: ReaderSettings): PageTurn {
  return { messages: headed(messages, settings) }
}

function wrappedLines(line: string, cols: number): number {
  return Math.max(1, Math.ceil(line.length / cols))
}

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

function visiblePromptText(user: AgentMessage): string {
  return user.parts.flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : [])).join("\n")
}

function drawnGroupLines(assistants: readonly AgentMessage[], cols: number, reasoning: boolean): number {
  const items = assistants.flatMap((message) =>
    message.parts.filter((part) => isGroupablePart(part, partHasText, reasoning)).map((part) => ({ messageId: message.info.id, part })),
  )
  const byId = new Map<string, AgentContentPart>(items.map((item) => [item.part.id, item.part]))
  return groupParts(items).reduce((lines, group) => {
    const only = group.type === "part" ? byId.get(group.ref.partId) : undefined
    return lines + (only?.type === "text" ? textLines(only.text, cols) : GROUP_ROW_LINES)
  }, 0)
}

type LineRequest = Pick<TurnPageRequest, "cols" | "reasoning" | "cancelledAssistantMessageId">

function drawnAssistants(assistants: readonly AssistantEntry[], request: LineRequest, compaction: boolean): { assistants: readonly AgentMessage[]; folded: boolean } {
  const last = assistants.at(-1)
  if (!last) return { assistants, folded: false }
  const { shape, groups, part } = turnGroups(assistants, request.reasoning, request.cancelledAssistantMessageId, compaction)
  const decision = turnFoldDecision({
    foldableCount: countFoldableGroups(groups, part),
    settled: shape.settled,
    interrupted: shape.interruptedMessageIndex !== -1,
    errored: !!shape.errorMessage,
    busy: !assistantMessageSettled(last.info),
  })
  if (!decision.folded) return { assistants, folded: false }
  const folded = foldedGroupKeys(decision, groups, part)
  const kept = new Set(groups.filter((group) => !folded.has(group.key)).flatMap((group) => groupMembers(group).map((ref) => ref.partId)))
  return { assistants: assistants.map((message) => ({ ...message, parts: message.parts.filter((item) => kept.has(item.id)) })), folded: true }
}

/** An estimate for choosing how many turns a page sends, never a layout. */
export function estimateTurnLines(messages: readonly AgentMessage[], request: LineRequest): number {
  const [user, ...rest] = messages
  if (!user) return 0
  const prompt = textLines(visiblePromptText(user), Math.max(1, Math.floor(request.cols * USER_BUBBLE_SHARE)))
  const compaction = user.parts.some((part) => part.type === "compaction")
  const drawn = drawnAssistants(rest.filter(isAssistant), request, compaction)
  return TURN_CHROME_LINES + prompt + (drawn.folded ? FOLD_ROW_LINES : 0) + drawnGroupLines(drawn.assistants, request.cols, request.reasoning)
}

const encoder = new TextEncoder()

/** The caps decide how many turns are sent; a message or part is never trimmed. */
export async function readTurnPage(read: TurnRead, request: TurnPageRequest): Promise<TurnPage> {
  const turns: PageTurn[] = []
  const wanted = request.rows * (1 + TURN_PAGE_FILL_SCREENS)
  const byteCap = request.before === undefined ? TURN_PAGE_BYTE_CAP : Number.POSITIVE_INFINITY
  let lines = 0
  let bytes = 0
  let before = request.before
  do {
    const page = await read(before)
    if (page.messages.length === 0) break
    const sent = projectTurn(page.messages, request)
    turns.unshift(page.nextCursor === undefined ? sent : { ...sent, cursor: page.nextCursor })
    lines += estimateTurnLines(page.messages, request)
    bytes += encoder.encode(JSON.stringify(sent.messages)).byteLength
    before = page.nextCursor
  } while (before !== undefined && lines < wanted && turns.length < TURN_PAGE_TURN_CAP && bytes < byteCap)
  return { turns }
}

export async function readFirstRead<Session>(
  session: Session,
  outline: TurnOutline,
  read: TurnRead,
  request: TurnPageRequest | undefined,
): Promise<FirstRead<Session>> {
  return request ? { session, outline, page: await readTurnPage(read, request) } : { session, outline }
}
