import { z } from "zod"
import {
  AdmissionProposalDtoSchema,
  AttemptDtoSchema,
  DecisionDtoSchema,
  RecapDtoSchema,
  WorkItemDtoSchema,
} from "./records"
import { ConnectionIDSchema, OwnerUserIDSchema, StreamIDSchema } from "./ids"
import { WorkGraphNotificationSchema } from "./notifications"
import { SourceProviderSchema } from "./source-view"

const prefix = "wgat1"
const maxLength = 512
const text = z.string().trim().min(1)
const timestamp = z.number().int().nonnegative()

export const AttentionKindSchema = z.enum([
  "admission_proposal",
  "decision",
  "work_item",
  "attempt",
  "recap_notification",
  "unorganized_ai_work",
  "configuration_required",
])
export type AttentionKind = z.infer<typeof AttentionKindSchema>

const itemShape = {
  ownerUserId: OwnerUserIDSchema,
  id: text,
  updatedAt: timestamp,
}

const AdmissionAttentionItemSchema = z.strictObject({
  ...itemShape,
  kind: z.literal("admission_proposal"),
  record: AdmissionProposalDtoSchema,
}).superRefine((item, context) => {
  if (item.record.state !== "proposed") {
    context.addIssue({ code: "custom", path: ["record", "state"], message: "Attention requires a reviewable admission proposal" })
  }
  recordIdentity(item, context)
})

const DecisionAttentionItemSchema = z.strictObject({
  ...itemShape,
  kind: z.literal("decision"),
  record: DecisionDtoSchema,
}).superRefine((item, context) => {
  if (item.record.state !== "proposed" && item.record.state !== "pending") {
    context.addIssue({ code: "custom", path: ["record", "state"], message: "Attention requires an unanswered Decision" })
  }
  recordIdentity(item, context)
})

const WorkItemAttentionItemSchema = z.strictObject({
  ...itemShape,
  kind: z.literal("work_item"),
  record: WorkItemDtoSchema,
}).superRefine((item, context) => {
  if (!["result_ready", "blocked", "review_needed", "integration_needed", "verification_failed", "failed"].includes(item.record.state)) {
    context.addIssue({ code: "custom", path: ["record", "state"], message: "Task state does not require owner attention" })
  }
  recordIdentity(item, context)
})

const AttemptAttentionItemSchema = z.strictObject({
  ...itemShape,
  kind: z.literal("attempt"),
  record: AttemptDtoSchema,
}).superRefine((item, context) => {
  if (item.record.state !== "attention") {
    context.addIssue({ code: "custom", path: ["record", "state"], message: "Attempt is not waiting for attention" })
  }
  recordIdentity(item, context)
})

const RecapNotificationAttentionItemSchema = z.strictObject({
  ...itemShape,
  kind: z.literal("recap_notification"),
  notification: WorkGraphNotificationSchema,
  recap: RecapDtoSchema,
}).superRefine((item, context) => {
  if (item.ownerUserId !== item.notification.ownerUserId || item.id !== item.notification.id || item.updatedAt !== item.notification.updatedAt) {
    context.addIssue({ code: "custom", path: ["notification"], message: "Attention identity must match its Recap notification" })
  }
  if (item.notification.state !== "unread" || item.notification.recapId !== item.recap.id ||
    item.notification.streamId !== item.recap.streamId || item.notification.ownerUserId !== item.recap.ownerUserId ||
    item.recap.actionableReferences.length === 0) {
    context.addIssue({ code: "custom", path: ["recap"], message: "Recap notification is not actionable" })
  }
})

const UnorganizedAIWorkAttentionItemSchema = z.strictObject({
  ...itemShape,
  id: z.literal("unorganized_ai_work"),
  kind: z.literal("unorganized_ai_work"),
  counts: z.strictObject({
    externalIssues: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    total: z.number().int().positive(),
  }),
}).superRefine((item, context) => {
  if (item.counts.total === item.counts.externalIssues + item.counts.sessions) return
  context.addIssue({ code: "custom", path: ["counts", "total"], message: "Unorganized AI work total must equal its kind counts" })
})

const ConfigurationRequiredAttentionItemSchema = z.strictObject({
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
      purpose: z.enum(["source_planning", "recap"]),
      scope: z.union([
        z.strictObject({ type: z.literal("workgraph") }),
        z.strictObject({ type: z.literal("stream"), streamId: StreamIDSchema }),
      ]),
      reason: text,
    }),
  ]),
}).superRefine((item, context) => {
  const requirementId = item.requirement.type === "connection" ? item.requirement.connectionId : item.requirement.jobId
  if (item.id === requirementId) return
  context.addIssue({ code: "custom", path: ["requirement"], message: "Configuration attention identity must match its requirement" })
})

export const AttentionItemSchema = z.union([
  AdmissionAttentionItemSchema,
  DecisionAttentionItemSchema,
  WorkItemAttentionItemSchema,
  AttemptAttentionItemSchema,
  RecapNotificationAttentionItemSchema,
  UnorganizedAIWorkAttentionItemSchema,
  ConfigurationRequiredAttentionItemSchema,
])
export type AttentionItem = z.infer<typeof AttentionItemSchema>

export const AttentionCursorSchema = z.string().trim().min(1).max(maxLength).brand("AttentionCursor")
export type AttentionCursor = z.infer<typeof AttentionCursorSchema>

export const AttentionListInputSchema = z.strictObject({
  after: AttentionCursorSchema.optional(),
  limit: z.number().int().min(1).max(100),
})
export type AttentionListInput = z.infer<typeof AttentionListInputSchema>

export const AttentionPageSchema = z.strictObject({
  items: z.array(AttentionItemSchema),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextCursor: AttentionCursorSchema.optional(),
}).superRefine((page, context) => {
  if (page.total < page.items.length) {
    context.addIssue({ code: "custom", path: ["total"], message: "Attention total cannot be smaller than the current page" })
  }
  if (page.hasMore === Boolean(page.nextCursor)) return
  context.addIssue({ code: "custom", path: ["nextCursor"], message: "An Attention cursor is required exactly when more items exist" })
})
export type AttentionPage = z.infer<typeof AttentionPageSchema>

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

export function createAttentionCursor(ownerUserId: string, position: AttentionPosition): AttentionCursor {
  const cursor = [prefix, encode(ownerUserId), integer(position.updatedAt), position.kind, encode(position.id)].join(":")
  if (cursor.length > maxLength) throw new AttentionCursorError("invalid")
  return AttentionCursorSchema.parse(cursor)
}

export function readAttentionCursor(cursor: string, ownerUserId: string): AttentionPosition {
  if (cursor.length > maxLength) throw new AttentionCursorError("invalid")
  const parts = cursor.split(":")
  if (parts.length !== 5 || parts[0] !== prefix) throw new AttentionCursorError("invalid")
  if (decode(parts[1]!) !== ownerUserId) throw new AttentionCursorError("owner_mismatch")
  return {
    updatedAt: integer(parts[2]),
    kind: AttentionKindSchema.parse(parts[3]),
    id: decode(parts[4]!),
  }
}

/** Orders newest activity first, then stable kind and identity tie-breakers. */
export function compareAttentionPosition(left: AttentionPosition, right: AttentionPosition) {
  return right.updatedAt - left.updatedAt || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)
}

function recordIdentity(
  item: Readonly<{ ownerUserId: string; id: string; updatedAt: number; record: { ownerUserId: string; id: string; updatedAt: number } }>,
  context: z.core.$RefinementCtx<unknown>,
) {
  if (item.ownerUserId === item.record.ownerUserId && item.id === item.record.id && item.updatedAt === item.record.updatedAt) return
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
