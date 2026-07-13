import { z } from "zod"
import { IntakeCandidateDtoSchema } from "./source-view"

const prefix = "wgic1"
const maxLength = 2048

export const IntakeCandidatePageCursorSchema = z.string().trim().min(1).max(maxLength).brand("IntakeCandidatePageCursor")
export type IntakeCandidatePageCursor = z.infer<typeof IntakeCandidatePageCursorSchema>

export const IntakeCandidateListInputSchema = z.strictObject({
  sourceViewId: z.string().trim().min(1).max(512).optional(),
  after: IntakeCandidatePageCursorSchema.optional(),
  limit: z.number().int().min(1).max(100),
})
export type IntakeCandidateListInput = z.infer<typeof IntakeCandidateListInputSchema>

export const IntakeCandidatePageSchema = z.strictObject({
  candidates: z.array(IntakeCandidateDtoSchema),
  hasMore: z.boolean(),
  nextCursor: IntakeCandidatePageCursorSchema.optional(),
}).superRefine((page, context) => {
  if (page.hasMore === Boolean(page.nextCursor)) return
  context.addIssue({
    code: "custom",
    path: ["nextCursor"],
    message: "An intake Candidate cursor is required exactly when more Candidates exist",
  })
})
export type IntakeCandidatePage = z.infer<typeof IntakeCandidatePageSchema>

export type IntakeCandidatePageCursorErrorReason = "invalid" | "owner_mismatch" | "source_view_mismatch"

export class IntakeCandidatePageCursorError extends Error {
  readonly code = "cursor_invalid" as const

  constructor(readonly reason: IntakeCandidatePageCursorErrorReason) {
    super("Candidate page cursor is not valid for this owner and Source View scope")
    this.name = "IntakeCandidatePageCursorError"
  }
}

export function createIntakeCandidatePageCursor(input: Readonly<{
  ownerUserId: string
  sourceViewId?: string
  updatedAt: number
  candidateId: string
}>): IntakeCandidatePageCursor {
  const cursor = [
    prefix,
    encode(input.ownerUserId),
    input.sourceViewId ? encode(input.sourceViewId) : "*",
    integer(input.updatedAt),
    encode(input.candidateId),
  ].join(":")
  if (cursor.length > maxLength) throw new IntakeCandidatePageCursorError("invalid")
  return IntakeCandidatePageCursorSchema.parse(cursor)
}

export function readIntakeCandidatePageCursor(
  cursor: string,
  ownerUserId: string,
  sourceViewId?: string,
): Readonly<{ updatedAt: number; candidateId: string }> {
  if (cursor.length > maxLength) throw new IntakeCandidatePageCursorError("invalid")
  const parts = cursor.split(":")
  if (parts.length !== 5 || parts[0] !== prefix) throw new IntakeCandidatePageCursorError("invalid")
  if (decode(parts[1]!) !== ownerUserId) throw new IntakeCandidatePageCursorError("owner_mismatch")
  const cursorSourceViewId = parts[2] === "*" ? undefined : decode(parts[2]!)
  if (cursorSourceViewId !== sourceViewId) throw new IntakeCandidatePageCursorError("source_view_mismatch")
  return { updatedAt: integer(parts[3]), candidateId: decode(parts[4]!) }
}

export function compareIntakeCandidatePosition(
  left: Readonly<{ updatedAt: number; id: string }>,
  right: Readonly<{ updatedAt: number; id: string }>,
) {
  return right.updatedAt - left.updatedAt || right.id.localeCompare(left.id)
}

function encode(value: string) {
  if (!value) throw new IntakeCandidatePageCursorError("invalid")
  return encodeURIComponent(value)
}

function decode(value: string) {
  try {
    const decoded = decodeURIComponent(value)
    if (!decoded || encodeURIComponent(decoded) !== value) throw new IntakeCandidatePageCursorError("invalid")
    return decoded
  } catch (error) {
    if (error instanceof IntakeCandidatePageCursorError) throw error
    throw new IntakeCandidatePageCursorError("invalid")
  }
}

function integer(value: number | string | undefined) {
  const parsed = Number(value)
  if (value === undefined || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new IntakeCandidatePageCursorError("invalid")
  }
  return parsed
}
