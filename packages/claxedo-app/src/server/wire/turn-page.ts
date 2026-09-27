import { isAgentContentPart } from "@claxedo/agent-runtime-contract"
import { isRecord } from "@claxedo/helpers/guards"
import { ServerError } from "../errors"
import type { PageShape, TranscriptEntry, TranscriptPage, TranscriptPart } from "../types"
import { transcriptPageFromWire } from "./transcript"

type PageTurn = { readonly entries: readonly TranscriptEntry[]; readonly cursor?: string }

function pageTurnFromWire(value: unknown): PageTurn {
  if (!isRecord(value)) throw new ServerError({ class: "internal", message: "A page turn is not a record" })
  const { entries } = transcriptPageFromWire(value.messages, null)
  return { entries, ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}) }
}

export function cursorPage(entries: readonly TranscriptEntry[], cursor: string | undefined): TranscriptPage {
  return { entries, ...(cursor ? { olderCursor: cursor } : {}) }
}

export function pageTurnsFromWire(body: unknown): readonly PageTurn[] {
  const turns = isRecord(body) && Array.isArray(body.turns) ? body.turns.map(pageTurnFromWire) : undefined
  if (!turns) throw new ServerError({ class: "internal", message: "The page is not a list of turns" })
  return turns
}

export function turnPageRead(turns: readonly PageTurn[]): TranscriptPage {
  return cursorPage(turns.flatMap((turn) => turn.entries), turns[0]?.cursor)
}

export function turnPageFromWire(body: unknown): TranscriptPage {
  return turnPageRead(pageTurnsFromWire(body))
}

export function partFromWire(body: unknown): TranscriptPart {
  if (!isAgentContentPart(body)) throw new ServerError({ class: "internal", message: "The part read did not answer a part" })
  return body
}

const flag = (value: boolean) => (value ? "1" : "0")

export function viewportQuery(shape: PageShape): Record<string, string> {
  return { rows: String(shape.rows), cols: String(shape.cols), reasoning: flag(shape.reasoning), shell: flag(shape.shell), edit: flag(shape.edit) }
}
