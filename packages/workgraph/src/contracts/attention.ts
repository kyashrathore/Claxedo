import { z } from "zod"
import {
  AdmissionProposalDtoSchema,
  RunDtoSchema,
  DecisionDtoSchema,
  WorkItemDtoSchema,
} from "./records"
import { ConnectionIDSchema, OwnerUserIDSchema, StreamIDSchema } from "./ids"
import { SourceProviderSchema } from "./source-view"

const prefix = "wgat1"
const maxLength = 512
const text = z.string().trim().min(1)
const timestamp = z.number().int().nonnegative()

export const AttentionKindSchema = z.enum([
  "admission_proposal",
  "decision",
  "work_item",
  "run",
  "unorganized_ai_work",
  "configuration_required",
  "master_escalation",
])
export type AttentionKind = z.infer<typeof AttentionKindSchema>

const itemShape = {
  ownerUserId: OwnerUserIDSchema,
  id: text,
  updatedAt: timestamp,
  readAt: timestamp.optional(),
}

const AdmissionAttentionItemSchema = z
  .strictObject({
    ...itemShape,
    kind: z.literal("admission_proposal"),
    record: AdmissionProposalDtoSchema,
  })
  .superRefine((item, context) => {
    if (item.record.state !== "proposed") {
      context.addIssue({
        code: "custom",
        path: ["record", "state"],
        message: "Attention requires a reviewable admission proposal",
      })
    }
    recordIdentity(item, context)
  })

const DecisionAttentionItemSchema = z
  .strictObject({
    ...itemShape,
    kind: z.literal("decision"),
    record: DecisionDtoSchema,
  })
  .superRefine((item, context) => {
    if (item.record.state !== "proposed" && item.record.state !== "pending") {
      context.addIssue({
        code: "custom",
        path: ["record", "state"],
        message: "Attention requires an unanswered Decision",
      })
    }
    recordIdentity(item, context)
  })

const WorkItemAttentionItemSchema = z
  .strictObject({
    ...itemShape,
    kind: z.literal("work_item"),
    record: WorkItemDtoSchema,
  })
  .superRefine((item, context) => {
    if (
      !["pending_approval", "result_ready", "blocked", "review_needed", "integration_needed", "verification_failed", "failed"].includes(
        item.record.state,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["record", "state"],
        message: "Task state does not require owner attention",
      })
    }
    recordIdentity(item, context)
  })

const RunAttentionItemSchema = z
  .strictObject({
    ...itemShape,
    kind: z.literal("run"),
    record: RunDtoSchema,
  })
  .superRefine((item, context) => {
    if (item.record.state !== "parked") {
      context.addIssue({ code: "custom", path: ["record", "state"], message: "Run is not waiting for attention" })
    }
    recordIdentity(item, context)
  })

const UnorganizedAIWorkAttentionItemSchema = z
  .strictObject({
    ...itemShape,
    id: z.literal("unorganized_ai_work"),
    kind: z.literal("unorganized_ai_work"),
    counts: z.strictObject({
      externalIssues: z.number().int().nonnegative(),
      sessions: z.number().int().nonnegative(),
      total: z.number().int().positive(),
    }),
  })
  .superRefine((item, context) => {
    if (item.counts.total === item.counts.externalIssues + item.counts.sessions) return
    context.addIssue({
      code: "custom",
      path: ["counts", "total"],
      message: "Unorganized AI work total must equal its kind counts",
    })
  })

const ConfigurationRequiredAttentionItemSchema = z
  .strictObject({
    ...itemShape,
    kind: z.literal("configuration_required"),
    requirement: z.union([
      z.strictObject({
        type: z.literal("connection"),
        connectionId: ConnectionIDSchema,
        integrationId: SourceProviderSchema,
        status: z.enum(["degraded", "broken"]),
        accountLabel: text.optional(),
      }),
      z.strictObject({
        type: z.literal("generation"),
        jobId: text,
        purpose: z.literal("source_planning"),
        scope: z.union([
          z.strictObject({ type: z.literal("workgraph") }),
          z.strictObject({ type: z.literal("stream"), streamId: StreamIDSchema }),
        ]),
        reason: text,
      }),
    ]),
  })
  .superRefine((item, context) => {
    const requirementId =
      item.requirement.type === "connection" ? item.requirement.connectionId : item.requirement.jobId
    if (item.id === requirementId) return
    context.addIssue({
      code: "custom",
      path: ["requirement"],
      message: "Configuration attention identity must match its requirement",
    })
  })

const MasterEscalationAttentionItemSchema = z.strictObject({
  ...itemShape,
  kind: z.literal("master_escalation"),
  streamId: StreamIDSchema,
  sessionId: text.optional(),
  /** Typed discriminant for the escalation's resolution affordance. Surfaces
   *  dispatch on this — never on the prose of `reason`. */
  category: z.enum(["public_pr_confirmation", "failure_halt"]).optional(),
  reason: text,
  evidenceIds: z.array(text).max(100).default([]),
  receiptRefs: z.array(text).max(100).default([]),
})

export const AttentionItemSchema = z.union([
  AdmissionAttentionItemSchema,
  DecisionAttentionItemSchema,
  WorkItemAttentionItemSchema,
  RunAttentionItemSchema,
  UnorganizedAIWorkAttentionItemSchema,
  ConfigurationRequiredAttentionItemSchema,
  MasterEscalationAttentionItemSchema,
]).superRefine((item, context) => {
  if (item.readAt === undefined || item.readAt >= item.updatedAt) return
  context.addIssue({ code: "custom", path: ["readAt"], message: "Attention cannot be read before its current update" })
})
export type AttentionItem = z.infer<typeof AttentionItemSchema>

export const AttentionCursorSchema = z.string().trim().min(1).max(maxLength).brand("AttentionCursor")
export type AttentionCursor = z.infer<typeof AttentionCursorSchema>

export const AttentionListInputSchema = z.strictObject({
  after: AttentionCursorSchema.optional(),
  limit: z.number().int().min(1).max(100),
})
export type AttentionListInput = z.infer<typeof AttentionListInputSchema>

export const AttentionPageSchema = z
  .strictObject({
    items: z.array(AttentionItemSchema),
    total: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    nextCursor: AttentionCursorSchema.optional(),
  })
  .superRefine((page, context) => {
    if (page.total < page.items.length) {
      context.addIssue({
        code: "custom",
        path: ["total"],
        message: "Attention total cannot be smaller than the current page",
      })
    }
    if (page.hasMore === Boolean(page.nextCursor)) return
    context.addIssue({
      code: "custom",
      path: ["nextCursor"],
      message: "An Attention cursor is required exactly when more items exist",
    })
  })
export type AttentionPage = z.infer<typeof AttentionPageSchema>

export const AttentionAcknowledgementSchema = z
  .strictObject({
    ownerUserId: OwnerUserIDSchema,
    readAt: timestamp,
    clearedAt: timestamp.optional(),
  })
  .superRefine((acknowledgement, context) => {
    if (acknowledgement.clearedAt === undefined || acknowledgement.clearedAt <= acknowledgement.readAt) return
    context.addIssue({
      code: "custom",
      path: ["clearedAt"],
      message: "Attention cannot be cleared after its read watermark",
    })
  })
export type AttentionAcknowledgement = z.infer<typeof AttentionAcknowledgementSchema>

export type AttentionCursorErrorReason = "invalid" | "owner_mismatch"

export class AttentionCursorError extends Error {
  readonly code = "cursor_invalid" as const

  constructor(readonly reason: AttentionCursorErrorReason) {
    super("Attention cursor is not valid for this owner")
    this.name = "AttentionCursorError"
  }
}

export type AttentionPosition = Readonly<{
  updatedAt: number
  kind: AttentionKind
  id: string
}>

export function createAttentionCursor(
  organizationId: string,
  ownerUserId: string,
  position: AttentionPosition,
): AttentionCursor {
  const cursor = [
    prefix,
    encode(organizationId),
    encode(ownerUserId),
    integer(position.updatedAt),
    position.kind,
    encode(position.id),
  ].join(":")
  if (cursor.length > maxLength) throw new AttentionCursorError("invalid")
  return AttentionCursorSchema.parse(cursor)
}

export function readAttentionCursor(cursor: string, organizationId: string, ownerUserId: string): AttentionPosition {
  if (cursor.length > maxLength) throw new AttentionCursorError("invalid")
  const parts = cursor.split(":")
  if (parts.length !== 6 || parts[0] !== prefix) throw new AttentionCursorError("invalid")
  if (decode(parts[1]!) !== organizationId || decode(parts[2]!) !== ownerUserId)
    throw new AttentionCursorError("owner_mismatch")
  const kind = AttentionKindSchema.safeParse(parts[4])
  if (!kind.success) throw new AttentionCursorError("invalid")
  return {
    updatedAt: integer(parts[3]),
    kind: kind.data,
    id: decode(parts[5]!),
  }
}

/** Orders newest activity first, then stable kind and identity tie-breakers. */
export function compareAttentionPosition(left: AttentionPosition, right: AttentionPosition) {
  return right.updatedAt - left.updatedAt || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)
}

function recordIdentity(
  item: Readonly<{
    ownerUserId: string
    id: string
    updatedAt: number
    record: { ownerUserId: string; id: string; updatedAt: number }
  }>,
  context: z.core.$RefinementCtx<unknown>,
) {
  if (
    item.ownerUserId === item.record.ownerUserId &&
    item.id === item.record.id &&
    item.updatedAt === item.record.updatedAt
  )
    return
  context.addIssue({ code: "custom", path: ["record"], message: "Attention identity must match its canonical record" })
}

function encode(value: string) {
  if (!value) throw new AttentionCursorError("invalid")
  return encodeURIComponent(value)
}

function decode(value: string) {
  try {
    const decoded = decodeURIComponent(value)
    if (!decoded || encodeURIComponent(decoded) !== value) throw new AttentionCursorError("invalid")
    return decoded
  } catch (error) {
    if (error instanceof AttentionCursorError) throw error
    throw new AttentionCursorError("invalid")
  }
}

function integer(value: number | string | undefined) {
  const parsed = Number(value)
  if (value === undefined || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AttentionCursorError("invalid")
  }
  return parsed
}
