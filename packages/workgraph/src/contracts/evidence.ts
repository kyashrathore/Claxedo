import { z } from "zod"
import { EvidenceDtoSchema, EvidenceSubjectSchema, type EvidenceSubject } from "./completion"
import { EvidenceIDSchema } from "./ids"

const prefix = "wgep1"
const maxLength = 512

export const EvidencePageCursorSchema = z.string().trim().min(1).max(maxLength).brand("EvidencePageCursor")
export type EvidencePageCursor = z.infer<typeof EvidencePageCursorSchema>

export const EvidenceReadInputSchema = z.strictObject({ evidenceId: EvidenceIDSchema })
export type EvidenceReadInput = z.infer<typeof EvidenceReadInputSchema>

export const EvidenceListInputSchema = z.strictObject({
  subject: EvidenceSubjectSchema,
  after: EvidencePageCursorSchema.optional(),
  limit: z.number().int().min(1).max(100),
})
export type EvidenceListInput = z.infer<typeof EvidenceListInputSchema>

export const EvidencePageSchema = z.strictObject({
  evidence: z.array(EvidenceDtoSchema),
  hasMore: z.boolean(),
  nextCursor: EvidencePageCursorSchema.optional(),
}).superRefine((page, context) => {
  if (page.hasMore === Boolean(page.nextCursor)) return
  context.addIssue({
    code: "custom",
    path: ["nextCursor"],
    message: "An Evidence page cursor is required exactly when more Evidence exists",
  })
})
export type EvidencePage = z.infer<typeof EvidencePageSchema>

export type EvidencePageCursorErrorReason = "invalid" | "owner_mismatch" | "subject_mismatch"

export class EvidencePageCursorError extends Error {
  readonly code = "cursor_invalid" as const

  constructor(readonly reason: EvidencePageCursorErrorReason) {
    super("Evidence page cursor is not valid for this owner and subject")
    this.name = "EvidencePageCursorError"
  }
}

export function createEvidencePageCursor(input: Readonly<{
  ownerUserId: string
  subject: EvidenceSubject
  recordedAt: number
  evidenceId: string
}>): EvidencePageCursor {
  const cursor = [
    prefix,
    encode(input.ownerUserId),
    input.subject.type,
    encode(subjectId(input.subject)),
    integer(input.recordedAt),
    encode(input.evidenceId),
  ].join(":")
  if (cursor.length > maxLength) throw new EvidencePageCursorError("invalid")
  return EvidencePageCursorSchema.parse(cursor)
}

export function readEvidencePageCursor(
  cursor: string,
  ownerUserId: string,
  subject: EvidenceSubject,
): Readonly<{ recordedAt: number; evidenceId: z.infer<typeof EvidenceIDSchema> }> {
  if (cursor.length > maxLength) throw new EvidencePageCursorError("invalid")
  const parts = cursor.split(":")
  if (parts.length !== 6 || parts[0] !== prefix) throw new EvidencePageCursorError("invalid")
  if (decode(parts[1]!) !== ownerUserId) throw new EvidencePageCursorError("owner_mismatch")
  if (parts[2] !== subject.type || decode(parts[3]!) !== subjectId(subject)) {
    throw new EvidencePageCursorError("subject_mismatch")
  }
  return {
    recordedAt: integer(parts[4]),
    evidenceId: EvidenceIDSchema.parse(decode(parts[5]!)),
  }
}

export function compareEvidenceCursorPosition(
  left: Readonly<{ recordedAt: number; id: string }>,
  right: Readonly<{ recordedAt: number; id: string }>,
) {
  return left.recordedAt - right.recordedAt || left.id.localeCompare(right.id)
}

function subjectId(subject: EvidenceSubject) {
  if (subject.type === "stream") return subject.streamId
  if (subject.type === "outcome") return subject.outcomeId
  return subject.workItemId
}

function encode(value: string) {
  if (!value) throw new EvidencePageCursorError("invalid")
  return encodeURIComponent(value)
}

function decode(value: string) {
  try {
    const decoded = decodeURIComponent(value)
    if (!decoded || encodeURIComponent(decoded) !== value) throw new EvidencePageCursorError("invalid")
    return decoded
  } catch (error) {
    if (error instanceof EvidencePageCursorError) throw error
    throw new EvidencePageCursorError("invalid")
  }
}

function integer(value: number | string | undefined) {
  const parsed = Number(value)
  if (value === undefined || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new EvidencePageCursorError("invalid")
  }
  return parsed
}
