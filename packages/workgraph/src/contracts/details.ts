import { z } from "zod"
import { AdmissionProposalIDSchema } from "./commands"
import {
  RunIDSchema,
  DecisionIDSchema,
  StreamIDSchema,
  WorkItemIDSchema,
} from "./ids"
import { WorkItemStateSchema } from "./lifecycle"
import {
  AdmissionProposalDtoSchema,
  RunDtoSchema,
  RunExecutionReferencesSchema,
  DecisionDtoSchema,
  WorkItemDtoSchema,
} from "./records"
import { IntakeCandidateDtoSchema } from "./source-view"
import { WorkSourceRevisionRefSchema } from "./work-source"

const prefix = "wgat1"
const maxLength = 512

export const AdmissionProposalReadInputSchema = z.strictObject({ proposalId: AdmissionProposalIDSchema })
export type AdmissionProposalReadInput = z.infer<typeof AdmissionProposalReadInputSchema>
export const WorkItemReadInputSchema = z.strictObject({ workItemId: WorkItemIDSchema })
export type WorkItemReadInput = z.infer<typeof WorkItemReadInputSchema>
export const RunReadInputSchema = z.strictObject({ runId: RunIDSchema })
export type RunReadInput = z.infer<typeof RunReadInputSchema>
export const DecisionReadInputSchema = z.strictObject({ decisionId: DecisionIDSchema })
export type DecisionReadInput = z.infer<typeof DecisionReadInputSchema>
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

export const RunDetailDtoSchema = z.strictObject({
  run: RunDtoSchema,
  executionReferences: RunExecutionReferencesSchema.optional(),
})
export type RunDetailDto = z.infer<typeof RunDetailDtoSchema>

export const WorkItemRunPageCursorSchema = z.string().trim().min(1).max(maxLength).brand("WorkItemRunPageCursor")
export type WorkItemRunPageCursor = z.infer<typeof WorkItemRunPageCursorSchema>

export const WorkItemRunListInputSchema = z.strictObject({
  workItemId: WorkItemIDSchema,
  after: WorkItemRunPageCursorSchema.optional(),
  limit: z.number().int().min(1).max(100),
})
export type WorkItemRunListInput = z.infer<typeof WorkItemRunListInputSchema>

export const WorkItemRunPageSchema = z.strictObject({
  runs: z.array(RunDetailDtoSchema),
  hasMore: z.boolean(),
  nextCursor: WorkItemRunPageCursorSchema.optional(),
}).superRefine((page, context) => {
  if (page.hasMore === Boolean(page.nextCursor)) return
  context.addIssue({
    code: "custom",
    path: ["nextCursor"],
    message: "An Run page cursor is required exactly when more Runs exist",
  })
})
export type WorkItemRunPage = z.infer<typeof WorkItemRunPageSchema>

export const WorkGraphDetailSchemas = {
  proposal: AdmissionProposalDtoSchema,
  workItem: WorkItemDtoSchema,
  run: RunDetailDtoSchema,
  decision: DecisionDtoSchema,
  candidate: IntakeCandidateDtoSchema,
  runs: WorkItemRunPageSchema,
  replacementReview: ReplacementReviewSchema,
} as const

export type WorkItemRunPageCursorErrorReason = "invalid" | "owner_mismatch" | "work_item_mismatch"

export class WorkItemRunPageCursorError extends Error {
  readonly code = "cursor_invalid" as const

  constructor(readonly reason: WorkItemRunPageCursorErrorReason) {
    super("Run page cursor is not valid for this owner and Work Item")
    this.name = "WorkItemRunPageCursorError"
  }
}

export function createWorkItemRunPageCursor(input: Readonly<{
  organizationId: string
  ownerUserId: string
  workItemId: string
  runNumber: number
  runId: string
}>): WorkItemRunPageCursor {
  const cursor = [
    prefix,
    encode(input.organizationId),
    encode(input.ownerUserId),
    encode(input.workItemId),
    integer(input.runNumber),
    encode(input.runId),
  ].join(":")
  if (cursor.length > maxLength) throw new WorkItemRunPageCursorError("invalid")
  return WorkItemRunPageCursorSchema.parse(cursor)
}

export function readWorkItemRunPageCursor(
  cursor: string,
  organizationId: string,
  ownerUserId: string,
  workItemId: string,
): Readonly<{ runNumber: number; runId: z.infer<typeof RunIDSchema> }> {
  if (cursor.length > maxLength) throw new WorkItemRunPageCursorError("invalid")
  const parts = cursor.split(":")
  if (parts.length !== 6 || parts[0] !== prefix) throw new WorkItemRunPageCursorError("invalid")
  if (decode(parts[1]!) !== organizationId || decode(parts[2]!) !== ownerUserId) throw new WorkItemRunPageCursorError("owner_mismatch")
  if (decode(parts[3]!) !== workItemId) throw new WorkItemRunPageCursorError("work_item_mismatch")
  return {
    runNumber: integer(parts[4]),
    runId: RunIDSchema.parse(decode(parts[5]!)),
  }
}

export function compareWorkItemRunPosition(
  left: Readonly<{ runNumber: number; id: string }>,
  right: Readonly<{ runNumber: number; id: string }>,
) {
  return left.runNumber - right.runNumber || left.id.localeCompare(right.id)
}

function encode(value: string) {
  if (!value) throw new WorkItemRunPageCursorError("invalid")
  return encodeURIComponent(value)
}

function decode(value: string) {
  try {
    const decoded = decodeURIComponent(value)
    if (!decoded || encodeURIComponent(decoded) !== value) throw new WorkItemRunPageCursorError("invalid")
    return decoded
  } catch (error) {
    if (error instanceof WorkItemRunPageCursorError) throw error
    throw new WorkItemRunPageCursorError("invalid")
  }
}

function integer(value: number | string | undefined) {
  const parsed = Number(value)
  if (value === undefined || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new WorkItemRunPageCursorError("invalid")
  }
  return parsed
}
