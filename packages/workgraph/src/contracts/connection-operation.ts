import { z } from "zod"

export const WorkGraphConnectionToolNames = [
  "connection_work_source_list",
  "connection_work_source_comment",
  "connection_work_source_update",
] as const
export type WorkGraphConnectionToolName = typeof WorkGraphConnectionToolNames[number]

const identity = z.object({
  attemptId: z.string().min(1),
  sessionId: z.string().min(1),
  workspaceId: z.string().min(1),
  connectionId: z.string().min(1),
}).strict()

export const WorkGraphConnectionOperationRequestSchema = z.object({
  version: z.literal(1),
  identity,
  operation: z.union([
    z.object({ type: z.literal("list"), providerUserId: z.string().min(1), filters: z.record(z.string(), z.string()), cursor: z.string().min(1).optional() }).strict(),
    z.object({ type: z.literal("comment"), externalId: z.string().min(1), body: z.string().min(1), idempotencyKey: z.string().min(1) }).strict(),
    z.object({ type: z.literal("update"), externalId: z.string().min(1), status: z.string().min(1).optional(), body: z.string().min(1).optional(), idempotencyKey: z.string().min(1) }).strict()
      .refine((value) => value.status !== undefined || value.body !== undefined),
  ]),
}).strict()

const issue = z.object({
  externalId: z.string(),
  externalKey: z.string().optional(),
  externalUrl: z.string().optional(),
  title: z.string(),
  body: z.string(),
  status: z.string(),
  updatedAt: z.number(),
  revision: z.string().optional(),
}).strict()

export const WorkGraphConnectionOperationResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("list"), issues: z.array(issue), cursor: z.string().optional() }).strict(),
  z.object({ type: z.literal("comment"), ok: z.literal(true) }).strict(),
  z.object({ type: z.literal("update"), ok: z.literal(true) }).strict(),
])

export type WorkGraphConnectionOperationRequest = z.infer<typeof WorkGraphConnectionOperationRequestSchema>
export type WorkGraphConnectionOperationResponse = z.infer<typeof WorkGraphConnectionOperationResponseSchema>
