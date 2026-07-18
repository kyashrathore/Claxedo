import { z } from "zod"

const sourcePrefix = "wgsrc1"
const maxLength = 2048

export const WorkSourcePageCursorSchema = z.string().trim().min(1).max(maxLength).brand("WorkSourcePageCursor")
export type WorkSourcePageCursor = z.infer<typeof WorkSourcePageCursorSchema>

export type WorkSourcePageCursorErrorReason = "invalid" | "owner_mismatch"

export class WorkSourcePageCursorError extends Error {
  readonly code = "cursor_invalid" as const

  constructor(readonly reason: WorkSourcePageCursorErrorReason) {
    super("Work Source page cursor is not valid for this owner")
    this.name = "WorkSourcePageCursorError"
  }
}

export function createWorkSourcePageCursor(input: Readonly<{
  organizationId: string
  ownerUserId: string
  createdAt: number
  sourceId: string
}>): WorkSourcePageCursor {
  const cursor = [sourcePrefix, encode(input.organizationId, WorkSourcePageCursorError), encode(input.ownerUserId, WorkSourcePageCursorError), integer(input.createdAt, WorkSourcePageCursorError), encode(input.sourceId, WorkSourcePageCursorError)].join(":")
  if (cursor.length > maxLength) throw new WorkSourcePageCursorError("invalid")
  return WorkSourcePageCursorSchema.parse(cursor)
}

export function readWorkSourcePageCursor(cursor: string, organizationId: string, ownerUserId: string) {
  if (cursor.length > maxLength) throw new WorkSourcePageCursorError("invalid")
  const parts = cursor.split(":")
  if (parts.length !== 5 || parts[0] !== sourcePrefix) throw new WorkSourcePageCursorError("invalid")
  if (decode(parts[1]!, WorkSourcePageCursorError) !== organizationId || decode(parts[2]!, WorkSourcePageCursorError) !== ownerUserId) {
    throw new WorkSourcePageCursorError("owner_mismatch")
  }
  return {
    createdAt: integer(parts[3], WorkSourcePageCursorError),
    sourceId: decode(parts[4]!, WorkSourcePageCursorError),
  }
}

type CursorError = new (reason: "invalid") => Error

function encode(value: string, ErrorType: CursorError) {
  if (!value) throw new ErrorType("invalid")
  return encodeURIComponent(value)
}

function decode(value: string, ErrorType: CursorError) {
  try {
    const decoded = decodeURIComponent(value)
    if (!decoded || encodeURIComponent(decoded) !== value) throw new ErrorType("invalid")
    return decoded
  } catch (error) {
    if (error instanceof ErrorType) throw error
    throw new ErrorType("invalid")
  }
}

function integer(value: number | string | undefined, ErrorType: CursorError) {
  const parsed = Number(value)
  if (value === undefined || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ErrorType("invalid")
  }
  return parsed
}
