import { isRecord } from "@claxedo/helpers/guards"
import { ServerError } from "../errors"
import type { TranscriptEntry, TranscriptPage } from "../types"

export const OLDER_CURSOR_HEADER = "X-Next-Cursor"

function isEntry(value: unknown): value is TranscriptEntry {
  return isRecord(value) && isRecord(value.info) && Array.isArray(value.parts)
}

export function transcriptPageFromWire(body: unknown, olderCursor: string | null): TranscriptPage {
  if (!Array.isArray(body)) throw new ServerError({ class: "internal", message: "The message page is not a list of messages" })
  return { entries: body.filter(isEntry), ...(olderCursor ? { olderCursor } : {}) }
}
