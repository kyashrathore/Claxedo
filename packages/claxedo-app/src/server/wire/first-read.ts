import { isRecord } from "@claxedo/helpers/guards"
import { ServerError } from "../errors"
import type { OutlineTurn, SessionOutline, TranscriptPage, TurnPageRead } from "../types"
import { cursorPage, pageTurnsFromWire, turnPageRead } from "./turn-page"

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

export type FirstPageFromWire = TurnPageRead & { readonly latestTurn: TranscriptPage | undefined }

export const NO_FIRST_PAGE: FirstPageFromWire = { transcript: { entries: [] }, folded: new Map(), latestTurn: undefined }

function firstPageFromWire(body: unknown): FirstPageFromWire {
  const turns = pageTurnsFromWire(body)
  const latest = turns.at(-1)
  return {
    ...turnPageRead(turns, undefined),
    latestTurn: latest && latest.foldableCount === undefined ? cursorPage(latest.entries, latest.cursor) : undefined,
  }
}

export type FirstReadFromWire = { readonly session: unknown; readonly outline: SessionOutline; readonly page?: FirstPageFromWire }

export function firstReadFromWire(body: unknown): FirstReadFromWire {
  if (!isRecord(body) || !isRecord(body.session)) throw new ServerError({ class: "internal", message: "The first read answered without its session" })
  return { session: body.session, outline: outlineFromWire(body.outline), ...(body.page === undefined ? {} : { page: firstPageFromWire(body.page) }) }
}
