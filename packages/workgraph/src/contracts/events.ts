import { z } from "zod"
import { AdmissionProposalIDSchema, ChangeCursorSchema, CommandProvenanceSchema } from "./commands"
import {
  AttemptIDSchema,
  DecisionIDSchema,
  EvidenceIDSchema,
  OutcomeIDSchema,
  OwnerUserIDSchema,
  RecapIDSchema,
  StreamIDSchema,
  WorkItemIDSchema,
  WorkGraphIDSchema,
  WorkSourceIDSchema,
} from "./ids"

const id = z.string().trim().min(1)

export const WorkGraphEventIDSchema = id.brand("WorkGraphEventID")
export type WorkGraphEventID = z.infer<typeof WorkGraphEventIDSchema>

export const WorkGraphEventTypeSchema = z.enum([
  "workgraph_defaults_updated",
  "work_source_created",
  "work_source_revised",
  "admission_proposed",
  "admission_proposal_updated",
  "admission_dismissed",
  "admission_reopened",
  "admission_confirmed",
  "stream_created",
  "stream_updated",
  "stream_lifecycle_changed",
  "stream_visibility_changed",
  "stream_execution_requested",
  "stream_replacement_reset_attention",
  "stream_replacement_reset_completed",
  "stream_closed",
  "stream_deleted",
  "outcome_created",
  "outcome_updated",
  "outcome_ready_to_close",
  "outcome_closed",
  "outcome_reopened",
  "work_item_created",
  "work_item_updated",
  "work_item_state_changed",
  "work_item_execution_requested",
  "attempt_admitted",
  "attempt_state_changed",
  "attempt_lease_recovered",
  "attempt_cancelled",
  "decision_proposed",
  "decision_answered",
  "decision_dismissed",
  "evidence_recorded",
  "recap_published",
])
export type WorkGraphEventType = z.infer<typeof WorkGraphEventTypeSchema>

const forbiddenPayloadKeys =
  /^(?:credential|credentials|password|passwords|secret|secrets|token|tokens|authorization|cookie|passphrase|privatekey|clientsecret|refreshtoken|accesstoken|apikey|authkey|bearertoken)$/

export const PublicEventPayloadSchema = z.json().superRefine((value, context) => {
  const inspect = (input: unknown, path: PropertyKey[]) => {
    if (Array.isArray(input)) {
      input.forEach((item, index) => inspect(item, [...path, index]))
      return
    }
    if (!input || typeof input !== "object") return
    Object.entries(input).forEach(([key, child]) => {
      if (forbiddenPayloadKeys.test(key.toLowerCase().replaceAll(/[^a-z0-9]/g, ""))) {
        context.addIssue({ code: "custom", message: "Event payloads cannot contain credentials", path: [...path, key] })
        return
      }
      inspect(child, [...path, key])
    })
  }
  inspect(value, [])
})
export type PublicEventPayload = z.infer<typeof PublicEventPayloadSchema>

export const WorkGraphEventEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: WorkGraphEventIDSchema,
  ownerUserId: OwnerUserIDSchema,
  streamId: StreamIDSchema.optional(),
  sequence: z.number().int().positive(),
  type: WorkGraphEventTypeSchema,
  payload: PublicEventPayloadSchema,
  provenance: CommandProvenanceSchema,
  occurredAt: z.number().int().nonnegative(),
})
export type WorkGraphEventEnvelope = z.infer<typeof WorkGraphEventEnvelopeSchema>

export const ChangeResourceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("workgraph"), id: WorkGraphIDSchema }),
  z.strictObject({ type: z.literal("work_source"), id: WorkSourceIDSchema }),
  z.strictObject({ type: z.literal("stream"), id: StreamIDSchema }),
  z.strictObject({ type: z.literal("outcome"), id: OutcomeIDSchema }),
  z.strictObject({ type: z.literal("work_item"), id: WorkItemIDSchema }),
  z.strictObject({ type: z.literal("attempt"), id: AttemptIDSchema }),
  z.strictObject({ type: z.literal("decision"), id: DecisionIDSchema }),
  z.strictObject({ type: z.literal("evidence"), id: EvidenceIDSchema }),
  z.strictObject({ type: z.literal("recap"), id: RecapIDSchema }),
  z.strictObject({ type: z.literal("admission_proposal"), id: AdmissionProposalIDSchema }),
])
export type ChangeResource = z.infer<typeof ChangeResourceSchema>

export const ChangeEnvelopeSchema = z.strictObject({
  cursor: ChangeCursorSchema,
  ownerUserId: OwnerUserIDSchema,
  resource: ChangeResourceSchema,
  event: WorkGraphEventEnvelopeSchema,
})
export type ChangeEnvelope = z.infer<typeof ChangeEnvelopeSchema>

export const WorkGraphChangeEnvelopeSchema = ChangeEnvelopeSchema
export type WorkGraphChangeEnvelope = ChangeEnvelope
