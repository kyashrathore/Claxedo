import { z } from "zod"
import { WorkGraphActorSchema } from "./context"
import {
  RunIDSchema,
  CompletionRequirementIDSchema,
  DurableEffectReceiptIDSchema,
  EvidenceIDSchema,
  OutcomeIDSchema,
  StreamIDSchema,
  WorkItemIDSchema,
} from "./ids"

const requirementShape = {
  id: CompletionRequirementIDSchema,
  description: z.string().trim().min(1),
}

export const CompletionRequirementSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...requirementShape, kind: z.literal("test"), command: z.string().trim().min(1).optional() }),
  z.strictObject({ ...requirementShape, kind: z.literal("artifact"), artifactType: z.string().trim().min(1).optional() }),
  z.strictObject({ ...requirementShape, kind: z.literal("review"), reviewerRole: z.string().trim().min(1).optional() }),
  z.strictObject({ ...requirementShape, kind: z.literal("integration"), target: z.string().trim().min(1).optional() }),
  z.strictObject({ ...requirementShape, kind: z.literal("verification"), instructions: z.string().trim().min(1) }),
  z.strictObject({ ...requirementShape, kind: z.literal("owner_confirmation") }),
])
export type CompletionRequirement = z.infer<typeof CompletionRequirementSchema>

export const CompletionContractSchema = z.strictObject({
  version: z.number().int().positive(),
  mode: z.enum(["all", "any"]),
  requirements: z.array(CompletionRequirementSchema).min(1),
}).superRefine((contract, context) => {
  const requirementIds = new Set(contract.requirements.map((requirement) => requirement.id))
  if (requirementIds.size === contract.requirements.length) return
  context.addIssue({
    code: "custom",
    path: ["requirements"],
    message: "Completion requirement IDs must be unique",
  })
})
export type CompletionContract = z.infer<typeof CompletionContractSchema>

export const EvidenceSubjectSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("stream"), streamId: StreamIDSchema }),
  z.strictObject({ type: z.literal("work_item"), workItemId: WorkItemIDSchema }),
  z.strictObject({ type: z.literal("outcome"), outcomeId: OutcomeIDSchema }),
])
export type EvidenceSubject = z.infer<typeof EvidenceSubjectSchema>

const evidenceShape = {
  id: EvidenceIDSchema,
  subject: EvidenceSubjectSchema,
  requirementId: CompletionRequirementIDSchema.optional(),
  sourceRunId: RunIDSchema.optional(),
  summary: z.string().trim().min(1),
  recordedAt: z.number().int().nonnegative(),
  recordedBy: WorkGraphActorSchema,
}

export const EvidenceDtoSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      ...evidenceShape,
      kind: z.literal("test_result"),
      passed: z.boolean(),
      command: z.string().trim().min(1).optional(),
      outputRef: z.string().trim().min(1).optional(),
    }),
    z.strictObject({
      ...evidenceShape,
      kind: z.literal("artifact"),
      artifactRef: z.string().trim().min(1),
      mediaType: z.string().trim().min(1).optional(),
    }),
    z.strictObject({
      ...evidenceShape,
      kind: z.literal("review"),
      verdict: z.enum(["approved", "changes_requested"]),
      reviewer: z.string().trim().min(1).optional(),
    }),
    z.strictObject({
      ...evidenceShape,
      kind: z.literal("integration"),
      effect: z.enum(["merged", "published", "accepted_external_write", "other"]),
      reference: z.string().trim().min(1),
      durableEffectReceiptId: DurableEffectReceiptIDSchema.optional(),
    }),
    z.strictObject({ ...evidenceShape, kind: z.literal("owner_confirmation"), confirmed: z.boolean() }),
    z.strictObject({ ...evidenceShape, kind: z.literal("finding"), sourceRef: z.string().trim().min(1).optional() }),
  ])
  .superRefine((evidence, context) => {
    if (evidence.kind !== "integration" || evidence.effect === "other" || evidence.durableEffectReceiptId) return
    context.addIssue({
      code: "custom",
      path: ["durableEffectReceiptId"],
      message: `A durable effect receipt is required for ${evidence.effect} integration evidence`,
    })
  })
  .readonly()
export type EvidenceDto = z.infer<typeof EvidenceDtoSchema>
