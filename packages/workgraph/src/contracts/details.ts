import { z } from "zod"
import { AdmissionProposalIDSchema } from "./commands"
import {
  AttemptIDSchema,
  DecisionIDSchema,
  RecapIDSchema,
  StreamIDSchema,
  WorkItemIDSchema,
} from "./ids"
import { WorkItemStateSchema } from "./lifecycle"
import {
  AdmissionProposalDtoSchema,
  AttemptDtoSchema,
  DecisionDtoSchema,
  RecapDtoSchema,
  WorkItemDtoSchema,
} from "./records"
import { IntakeCandidateDtoSchema } from "./source-view"
import { WorkSourceRevisionRefSchema } from "./work-source"

const prefix = "wgat1"
const maxLength = 512
const runtimeReference = z.string().trim().min(1).max(512)

export const AdmissionProposalReadInputSchema = z.strictObject({ proposalId: AdmissionProposalIDSchema })
export type AdmissionProposalReadInput = z.infer<typeof AdmissionProposalReadInputSchema>
export const WorkItemReadInputSchema = z.strictObject({ workItemId: WorkItemIDSchema })
export type WorkItemReadInput = z.infer<typeof WorkItemReadInputSchema>
export const AttemptReadInputSchema = z.strictObject({ attemptId: AttemptIDSchema })
export type AttemptReadInput = z.infer<typeof AttemptReadInputSchema>
export const DecisionReadInputSchema = z.strictObject({ decisionId: DecisionIDSchema })
export type DecisionReadInput = z.infer<typeof DecisionReadInputSchema>
export const RecapReadInputSchema = z.strictObject({ recapId: RecapIDSchema })
export type RecapReadInput = z.infer<typeof RecapReadInputSchema>
export const IntakeCandidateReadInputSchema = z.strictObject({ candidateId: z.string().trim().min(1).max(512) })
export type IntakeCandidateReadInput = z.infer<typeof IntakeCandidateReadInputSchema>

export const ReplacementReviewInputSchema = z.strictObject({
  streamId: StreamIDSchema,
  previousSource: WorkSourceRevisionRefSchema,
})
export type ReplacementReviewInput = z.infer<typeof ReplacementReviewInputSchema>

export const ReplacementTargetSchema = z.strictObject({
  workItemId: WorkItemIDSchema,
  expectedVersion: z.number().int().positive(),
  title: z.string().trim().min(1),
  state: WorkItemStateSchema,
})
export type ReplacementTarget = z.infer<typeof ReplacementTargetSchema>

const replacementReviewBase = {
  streamId: StreamIDSchema,
  streamTitle: z.string().trim().min(1),
}

export const ReplacementReviewSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...replacementReviewBase,
    status: z.literal("eligible"),
    targets: z.array(ReplacementTargetSchema).min(1),
  }),
  z.strictObject({
    ...replacementReviewBase,
    status: z.literal("empty"),
    reason: z.string().trim().min(1),
  }),
  z.strictObject({
    ...replacementReviewBase,
    status: z.literal("unrelated"),
    reason: z.string().trim().min(1),
  }),
  z.strictObject({
    ...replacementReviewBase,
    status: z.literal("durable"),
    reason: z.string().trim().min(1),
  }),
  z.strictObject({
    ...replacementReviewBase,
    status: z.literal("unavailable"),
    reason: z.string().trim().min(1),
  }),
])
export type ReplacementReview = z.infer<typeof ReplacementReviewSchema>

export const AttemptExecutionReferencesSchema = z.strictObject({
  sessionId: runtimeReference.optional(),
  workspaceId: runtimeReference.optional(),
  childWorkspaceId: runtimeReference.optional(),
}).refine((references) => references.sessionId || references.workspaceId || references.childWorkspaceId, {
  message: "Attempt execution references cannot be empty",
})

export const AttemptDetailDtoSchema = z.strictObject({
  attempt: AttemptDtoSchema,
  executionReferences: AttemptExecutionReferencesSchema.optional(),
})
export type AttemptDetailDto = z.infer<typeof AttemptDetailDtoSchema>

export const WorkItemAttemptPageCursorSchema = z.string().trim().min(1).max(maxLength).brand("WorkItemAttemptPageCursor")
export type WorkItemAttemptPageCursor = z.infer<typeof WorkItemAttemptPageCursorSchema>

export const WorkItemAttemptListInputSchema = z.strictObject({
  workItemId: WorkItemIDSchema,
  after: WorkItemAttemptPageCursorSchema.optional(),
  limit: z.number().int().min(1).max(100),
})
export type WorkItemAttemptListInput = z.infer<typeof WorkItemAttemptListInputSchema>

export const WorkItemAttemptPageSchema = z.strictObject({
  attempts: z.array(AttemptDetailDtoSchema),
  hasMore: z.boolean(),
  nextCursor: WorkItemAttemptPageCursorSchema.optional(),
}).superRefine((page, context) => {
  if (page.hasMore === Boolean(page.nextCursor)) return
  context.addIssue({
    code: "custom",
    path: ["nextCursor"],
    message: "An Attempt page cursor is required exactly when more Attempts exist",
  })
})
export type WorkItemAttemptPage = z.infer<typeof WorkItemAttemptPageSchema>

export const WorkGraphDetailSchemas = {
  proposal: AdmissionProposalDtoSchema,
  workItem: WorkItemDtoSchema,
  attempt: AttemptDetailDtoSchema,
  decision: DecisionDtoSchema,
  recap: RecapDtoSchema,
  candidate: IntakeCandidateDtoSchema,
  attempts: WorkItemAttemptPageSchema,
  replacementReview: ReplacementReviewSchema,
} as const

export type WorkItemAttemptPageCursorErrorReason = "invalid" | "owner_mismatch" | "work_item_mismatch"

export class WorkItemAttemptPageCursorError extends Error {
  readonly code = "cursor_invalid" as const

  constructor(readonly reason: WorkItemAttemptPageCursorErrorReason) {
    super("Attempt page cursor is not valid for this owner and Work Item")
    this.name = "WorkItemAttemptPageCursorError"
  }
}

export function createWorkItemAttemptPageCursor(input: Readonly<{
  organizationId: string
  ownerUserId: string
  workItemId: string
  attemptNumber: number
  attemptId: string
}>): WorkItemAttemptPageCursor {
  const cursor = [
    prefix,
    encode(input.organizationId),
    encode(input.ownerUserId),
    encode(input.workItemId),
    integer(input.attemptNumber),
    encode(input.attemptId),
  ].join(":")
  if (cursor.length > maxLength) throw new WorkItemAttemptPageCursorError("invalid")
  return WorkItemAttemptPageCursorSchema.parse(cursor)
}

export function readWorkItemAttemptPageCursor(
  cursor: string,
  organizationId: string,
  ownerUserId: string,
  workItemId: string,
): Readonly<{ attemptNumber: number; attemptId: z.infer<typeof AttemptIDSchema> }> {
  if (cursor.length > maxLength) throw new WorkItemAttemptPageCursorError("invalid")
  const parts = cursor.split(":")
  if (parts.length !== 6 || parts[0] !== prefix) throw new WorkItemAttemptPageCursorError("invalid")
  if (decode(parts[1]!) !== organizationId || decode(parts[2]!) !== ownerUserId) throw new WorkItemAttemptPageCursorError("owner_mismatch")
  if (decode(parts[3]!) !== workItemId) throw new WorkItemAttemptPageCursorError("work_item_mismatch")
  return {
    attemptNumber: integer(parts[4]),
    attemptId: AttemptIDSchema.parse(decode(parts[5]!)),
  }
}

export function compareWorkItemAttemptPosition(
  left: Readonly<{ attemptNumber: number; id: string }>,
  right: Readonly<{ attemptNumber: number; id: string }>,
) {
  return left.attemptNumber - right.attemptNumber || left.id.localeCompare(right.id)
}

function encode(value: string) {
  if (!value) throw new WorkItemAttemptPageCursorError("invalid")
  return encodeURIComponent(value)
}

function decode(value: string) {
  try {
    const decoded = decodeURIComponent(value)
    if (!decoded || encodeURIComponent(decoded) !== value) throw new WorkItemAttemptPageCursorError("invalid")
    return decoded
  } catch (error) {
    if (error instanceof WorkItemAttemptPageCursorError) throw error
    throw new WorkItemAttemptPageCursorError("invalid")
  }
}

function integer(value: number | string | undefined) {
  const parsed = Number(value)
  if (value === undefined || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new WorkItemAttemptPageCursorError("invalid")
  }
  return parsed
}
