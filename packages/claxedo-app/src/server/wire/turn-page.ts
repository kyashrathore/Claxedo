import { isAgentContentPart } from "@claxedo/agent-runtime-contract"
import { isRecord } from "@claxedo/helpers/guards"
import { ServerError } from "../errors"
import type { FoldedTurn, PageShape, ReaderSettings, TranscriptEntry, TranscriptPage, TranscriptPart, TurnPageRead } from "../types"
import { transcriptPageFromWire } from "./transcript"

type PageTurn = { readonly entries: readonly TranscriptEntry[]; readonly foldableCount?: number; readonly cursor?: string }

function pageTurnFromWire(value: unknown): PageTurn {
  if (!isRecord(value)) throw new ServerError({ class: "internal", message: "A page turn is not a record" })
  const { entries } = transcriptPageFromWire(value.messages, null)
  return {
    entries,
    ...(typeof value.foldableCount === "number" ? { foldableCount: value.foldableCount } : {}),
    ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
  }
}

export function cursorPage(entries: readonly TranscriptEntry[], cursor: string | undefined): TranscriptPage {
  return { entries, ...(cursor ? { olderCursor: cursor } : {}) }
}

export function pageTurnsFromWire(body: unknown): readonly PageTurn[] {
  const turns = isRecord(body) && Array.isArray(body.turns) ? body.turns.map(pageTurnFromWire) : undefined
  if (!turns) throw new ServerError({ class: "internal", message: "The page is not a list of turns" })
  return turns
}

export function turnPageRead(turns: readonly PageTurn[], readBefore: string | undefined): TurnPageRead {
  const folded = new Map<string, FoldedTurn>()
  turns.forEach((turn, index) => {
    const userMessageId = turn.entries[0]?.info.id
    const openBefore = index + 1 < turns.length ? turns[index + 1]?.cursor : readBefore
    if (userMessageId && turn.foldableCount !== undefined) folded.set(userMessageId, { foldableCount: turn.foldableCount, ...(openBefore ? { openBefore } : {}) })
  })
  return { transcript: cursorPage(turns.flatMap((turn) => turn.entries), turns[0]?.cursor), folded }
}

export function turnPageFromWire(body: unknown, readBefore: string): TurnPageRead {
  return turnPageRead(pageTurnsFromWire(body), readBefore)
}

export function openTurnFromWire(body: unknown): TranscriptPage {
  const turn = pageTurnFromWire(body)
  return cursorPage(turn.entries, turn.cursor)
}

export function partFromWire(body: unknown): TranscriptPart {
  if (!isAgentContentPart(body)) throw new ServerError({ class: "internal", message: "The part read did not answer a part" })
  return body
}

const flag = (value: boolean) => (value ? "1" : "0")

export function settingsQuery(settings: ReaderSettings): Record<string, string> {
  return { reasoning: flag(settings.reasoning), shell: flag(settings.shell), edit: flag(settings.edit) }
}

export function viewportQuery(shape: PageShape): Record<string, string> {
  return { rows: String(shape.rows), cols: String(shape.cols), ...settingsQuery(shape) }
}
