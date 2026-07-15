import { z } from "zod"
import { AdmissionProposalIDSchema } from "./commands"
import { ExecutionProfileDefaultsSchema } from "./execution"
import { ConnectionIDSchema } from "./ids"
import { WorkSourceRevisionRefSchema } from "./work-source"

const text = z.string().trim().min(1)
const timestamp = z.number().int().nonnegative()

export const SourceProviderSchema = z.enum(["github", "linear", "jira"])
export type SourceProvider = z.infer<typeof SourceProviderSchema>

export const SourceSyncPolicySchema = z.enum(["silent", "announce", "full"])
export type SourceSyncPolicy = z.infer<typeof SourceSyncPolicySchema>

export const SourceViewStatusSchema = z.enum(["active", "paused"])
export type SourceViewStatus = z.infer<typeof SourceViewStatusSchema>

export const SourceViewDtoSchema = z.strictObject({
  id: text,
  ownerUserId: text,
  version: z.number().int().positive(),
  teamConnectionId: ConnectionIDSchema,
  provider: SourceProviderSchema,
  providerUserId: text,
  filters: z.record(z.string(), z.string()),
  syncPolicy: SourceSyncPolicySchema,
  status: SourceViewStatusSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
})
export type SourceViewDto = z.infer<typeof SourceViewDtoSchema>

export const CreateSourceViewInputSchema = z.strictObject({
  teamConnectionId: ConnectionIDSchema,
  provider: SourceProviderSchema,
  providerUserId: text,
  filters: z.record(z.string(), z.string()).default({}),
  syncPolicy: SourceSyncPolicySchema.optional(),
})
export type CreateSourceViewInput = z.infer<typeof CreateSourceViewInputSchema>

export const UpdateSourceViewInputSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  providerUserId: text,
  filters: z.record(z.string(), z.string()),
  syncPolicy: SourceSyncPolicySchema,
  status: SourceViewStatusSchema,
})
export type UpdateSourceViewInput = z.infer<typeof UpdateSourceViewInputSchema>

export const SourceViewVersionInputSchema = z.strictObject({ expectedVersion: z.number().int().positive() })

const IntakeCandidateBaseSchema = z.strictObject({
  id: text,
  ownerUserId: text,
  version: z.number().int().positive(),
  title: text,
  body: z.string(),
  observedRevision: text.optional(),
  state: z.enum(["unorganized", "staged", "confirmed", "dismissed"]),
  source: WorkSourceRevisionRefSchema.optional(),
  admissionProposalId: AdmissionProposalIDSchema.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
})

export const IntakeCandidateDtoSchema = z.discriminatedUnion("candidateKind", [
  IntakeCandidateBaseSchema.extend({
    candidateKind: z.literal("external_issue"),
    sourceViewId: text,
    provider: SourceProviderSchema,
    externalId: text,
    externalKey: text.optional(),
    externalUrl: z.string().url().optional(),
    externalStatus: text,
  }),
  IntakeCandidateBaseSchema.extend({
    candidateKind: z.literal("session"),
    sessionId: text,
    execution: ExecutionProfileDefaultsSchema.optional(),
  }),
])
export type IntakeCandidateDto = z.infer<typeof IntakeCandidateDtoSchema>

export const SourceViewListResponseSchema = z.strictObject({ sourceViews: z.array(SourceViewDtoSchema) })
export const SourceViewRefreshResponseSchema = z.strictObject({
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  candidates: z.array(IntakeCandidateDtoSchema),
})
