import { isRecord } from "@claxedo/helpers/guards"
import { ServerError } from "../errors"
import type { FirstPageShape, FoldedTurn, OutlineTurn, SessionOutline, TranscriptEntry, TranscriptPage } from "../types"
import { transcriptPageFromWire } from "./transcript"

type WireTurn = {
  id?: unknown
  createdAt?: unknown
  title?: unknown
  user?: unknown
}

function turnFromWire(value: unknown): OutlineTurn | undefined {
  const row = value as WireTurn | null
  if (!row || typeof row.id !== "string") return undefined
  return {
    id: row.id,
    createdAt: typeof row.createdAt === "number" ? row.createdAt : 0,
    ...(typeof row.title === "string" ? { title: row.title } : {}),
    preview: typeof row.user === "string" ? { user: row.user } : {},
  }
}

function outlineFromWire(body: unknown): SessionOutline {
  const record = body as { turns?: unknown; complete?: unknown } | null
  if (!record || !Array.isArray(record.turns)) throw new ServerError({ class: "internal", message: "The turn outline is not a list of turns" })
  return { turns: record.turns.flatMap((turn) => turnFromWire(turn) ?? []), complete: record.complete === true }
}

export type FirstPageFromWire = {
  readonly transcript: TranscriptPage
  readonly folded: ReadonlyMap<string, FoldedTurn>
  readonly latestTurn: TranscriptPage | undefined
}

export const NO_FIRST_PAGE: FirstPageFromWire = { transcript: { entries: [] }, folded: new Map(), latestTurn: undefined }

type PageTurn = { readonly entries: readonly TranscriptEntry[]; readonly foldableCount?: number; readonly cursor?: string }

function pageTurnFromWire(value: unknown): PageTurn {
  if (!isRecord(value)) throw new ServerError({ class: "internal", message: "A first page turn is not a record" })
  const { entries } = transcriptPageFromWire(value.messages, null)
  return {
    entries,
    ...(typeof value.foldableCount === "number" ? { foldableCount: value.foldableCount } : {}),
    ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
  }
}

function cursorPage(entries: readonly TranscriptEntry[], cursor: string | undefined): TranscriptPage {
  return { entries, ...(cursor ? { olderCursor: cursor } : {}) }
}

function firstPageFromWire(body: unknown): FirstPageFromWire {
  const turns = isRecord(body) && Array.isArray(body.turns) ? body.turns.map(pageTurnFromWire) : undefined
  if (!turns) throw new ServerError({ class: "internal", message: "The first page is not a list of turns" })
  const folded = new Map<string, FoldedTurn>()
  turns.forEach((turn, index) => {
    const userMessageId = turn.entries[0]?.info.id
    const wholeBefore = turns[index + 1]?.cursor
    if (userMessageId && turn.foldableCount !== undefined) folded.set(userMessageId, { foldableCount: turn.foldableCount, ...(wholeBefore ? { wholeBefore } : {}) })
  })
  const latest = turns.at(-1)
  return {
    transcript: cursorPage(turns.flatMap((turn) => turn.entries), turns[0]?.cursor),
    folded,
    latestTurn: latest && latest.foldableCount === undefined ? cursorPage(latest.entries, latest.cursor) : undefined,
  }
}

export type FirstReadFromWire = { readonly session: unknown; readonly outline: SessionOutline; readonly page?: FirstPageFromWire }

export function firstReadFromWire(body: unknown): FirstReadFromWire {
  if (!isRecord(body) || !isRecord(body.session)) throw new ServerError({ class: "internal", message: "The first read answered without its session" })
  return { session: body.session, outline: outlineFromWire(body.outline), ...(body.page === undefined ? {} : { page: firstPageFromWire(body.page) }) }
}

export function viewportQuery(shape: FirstPageShape): Record<string, string> {
  const flag = (value: boolean) => (value ? "1" : "0")
  return { rows: String(shape.rows), cols: String(shape.cols), reasoning: flag(shape.reasoning), shell: flag(shape.shell), edit: flag(shape.edit) }
}
