import { z } from "zod"

export const WorkGraphConnectionToolNames = [
  "connection_work_source_list",
  "connection_work_source_comment",
  "connection_work_source_update",
  "connection_code_host_open_pr",
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
    z.object({
      type: z.literal("open_pull_request"),
      repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
      head: z.string().min(1),
      base: z.string().min(1),
      title: z.string().min(1),
      body: z.string().optional(),
      draft: z.boolean().default(true),
      publicRepository: z.boolean().default(true),
      idempotencyKey: z.string().min(1),
    }).strict(),
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
  z.object({
    type: z.literal("open_pull_request"),
    pullRequestId: z.string().min(1),
    url: z.string().url(),
    draft: z.boolean(),
    durableEffectReceiptId: z.string().min(1).optional(),
    evidenceId: z.string().min(1).optional(),
  }).strict(),
])

export type WorkGraphConnectionOperationRequest = z.infer<typeof WorkGraphConnectionOperationRequestSchema>
export type WorkGraphConnectionOperationResponse = z.infer<typeof WorkGraphConnectionOperationResponseSchema>
