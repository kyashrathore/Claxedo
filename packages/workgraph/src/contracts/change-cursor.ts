import { z } from "zod"

const prefix = "wgc2"
const maxLength = 2048

export const ChangeCursorSchema = z.string().trim().min(1).max(maxLength).brand("ChangeCursor")
export type ChangeCursor = z.infer<typeof ChangeCursorSchema>

export type ChangeCursorScope = Readonly<{ type: "all" } | { type: "stream"; streamId: string }>
export type ChangeCursorErrorReason = "invalid" | "owner_mismatch" | "filter_mismatch"

export class ChangeCursorError extends Error {
  readonly code = "cursor_invalid" as const

  constructor(readonly reason: ChangeCursorErrorReason) {
    super("Change cursor is not valid for this owner and filter")
    this.name = "ChangeCursorError"
  }
}

export function createChangeCursor(input: Readonly<{
  organizationId: string
  ownerUserId: string
  scope?: ChangeCursorScope
  position: number
}>): ChangeCursor {
  const scope = input.scope ?? { type: "all" as const }
  const cursor = [
    prefix,
    encode(input.organizationId),
    encode(input.ownerUserId),
    scope.type,
    scope.type === "stream" ? encode(scope.streamId) : "*",
    position(input.position),
  ].join(":")
  if (cursor.length > maxLength) throw new ChangeCursorError("invalid")
  return ChangeCursorSchema.parse(cursor)
}

export function readChangeCursor(
  cursor: string,
  organizationId: string,
  ownerUserId: string,
  scope: ChangeCursorScope = { type: "all" },
): number {
  const parsed = parseChangeCursor(cursor)
  if (parsed.organizationId !== organizationId || parsed.ownerUserId !== ownerUserId) {
    throw new ChangeCursorError("owner_mismatch")
  }
  if (parsed.scope.type !== scope.type) throw new ChangeCursorError("filter_mismatch")
  if (parsed.scope.type === "stream" && (scope.type !== "stream" || parsed.scope.streamId !== scope.streamId)) {
    throw new ChangeCursorError("filter_mismatch")
  }
  return parsed.position
}

export function readAllChangeCursorPosition(cursor: string) {
  const parsed = parseChangeCursor(cursor)
  if (parsed.scope.type !== "all") throw new ChangeCursorError("filter_mismatch")
  return parsed.position
}

function parseChangeCursor(cursor: string) {
  if (cursor.length > maxLength) throw new ChangeCursorError("invalid")
  const parts = cursor.split(":")
  if (parts.length !== 6 || parts[0] !== prefix) throw new ChangeCursorError("invalid")
  const cursorScope = parts[3] === "all"
    ? { type: "all" as const }
    : parts[3] === "stream"
      ? { type: "stream" as const, streamId: decode(parts[4]!) }
      : undefined
  if (!cursorScope || (cursorScope.type === "all" && parts[4] !== "*")) throw new ChangeCursorError("invalid")
  return {
    organizationId: decode(parts[1]!),
    ownerUserId: decode(parts[2]!),
    scope: cursorScope,
    position: position(parts[5]),
  }
}

function encode(value: string) {
  if (!value) throw new ChangeCursorError("invalid")
  return encodeURIComponent(value)
}

function decode(value: string) {
  try {
    const decoded = decodeURIComponent(value)
    if (!decoded || encodeURIComponent(decoded) !== value) throw new ChangeCursorError("invalid")
    return decoded
  } catch (error) {
    if (error instanceof ChangeCursorError) throw error
    throw new ChangeCursorError("invalid")
  }
}

function position(value: number | string | undefined) {
  const parsed = Number(value)
  if (value === undefined || !/^\d+(?:\.\d+)?$/.test(String(value)) || !Number.isFinite(parsed) || parsed < 0) {
    throw new ChangeCursorError("invalid")
  }
  return parsed
}
