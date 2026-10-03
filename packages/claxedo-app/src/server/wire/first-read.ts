import { isRecord } from "@claxedo/helpers/guards"
import { ServerError } from "../errors"
import type { OutlineTurn, SessionOutline, TranscriptPage } from "../types"
import { cursorPage, pageTurnsFromWire, turnPageRead } from "./turn-page"

function turnFromWire(row: unknown): OutlineTurn | undefined {
  if (!isRecord(row) || typeof row.id !== "string") return undefined
  return {
    id: row.id,
    createdAt: typeof row.createdAt === "number" ? row.createdAt : 0,
    ...(typeof row.title === "string" ? { title: row.title } : {}),
    preview: typeof row.user === "string" ? { user: row.user } : {},
  }
}

function outlineFromWire(record: unknown): SessionOutline {
  if (!isRecord(record) || !Array.isArray(record.turns)) throw new ServerError({ class: "internal", message: "The turn outline is not a list of turns" })
  return { turns: record.turns.flatMap((turn) => turnFromWire(turn) ?? []), complete: record.complete === true }
}

export type FirstPageFromWire = { readonly transcript: TranscriptPage; readonly latestTurn: TranscriptPage | undefined }

export const NO_FIRST_PAGE: FirstPageFromWire = { transcript: { entries: [] }, latestTurn: undefined }

function firstPageFromWire(body: unknown): FirstPageFromWire {
  const turns = pageTurnsFromWire(body)
  const latest = turns.at(-1)
  return { transcript: turnPageRead(turns), latestTurn: latest ? cursorPage(latest.entries, latest.cursor) : undefined }
}

export type FirstReadFromWire = { readonly session: unknown; readonly outline: SessionOutline; readonly page?: FirstPageFromWire }

export function firstReadFromWire(body: unknown): FirstReadFromWire {
  if (!isRecord(body) || !isRecord(body.session)) throw new ServerError({ class: "internal", message: "The first read answered without its session" })
  return { session: body.session, outline: outlineFromWire(body.outline), ...(body.page === undefined ? {} : { page: firstPageFromWire(body.page) }) }
}
