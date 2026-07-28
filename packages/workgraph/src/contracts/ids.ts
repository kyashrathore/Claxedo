import { z } from "zod"

const id = <Brand extends string>(brand: Brand) => z.string().trim().min(1).brand(brand)

export const OwnerUserIDSchema = id("OwnerUserID")
export type OwnerUserID = z.infer<typeof OwnerUserIDSchema>

export const OrganizationIDSchema = id("OrganizationID")
export type OrganizationID = z.infer<typeof OrganizationIDSchema>

export const ActorIDSchema = id("ActorID")
export type ActorID = z.infer<typeof ActorIDSchema>

export const RequestIDSchema = id("RequestID")
export type RequestID = z.infer<typeof RequestIDSchema>

export const OperationIDSchema = id("OperationID")
export type OperationID = z.infer<typeof OperationIDSchema>

export const WorkGraphIDSchema = id("WorkGraphID")
export type WorkGraphID = z.infer<typeof WorkGraphIDSchema>

export const StreamIDSchema = id("StreamID")
export type StreamID = z.infer<typeof StreamIDSchema>

export const OutcomeIDSchema = id("OutcomeID")
export type OutcomeID = z.infer<typeof OutcomeIDSchema>

export const WorkItemIDSchema = id("WorkItemID")
export type WorkItemID = z.infer<typeof WorkItemIDSchema>

export const RunIDSchema = id("RunID")
export type RunID = z.infer<typeof RunIDSchema>

export const AgentCheckpointIDSchema = id("AgentCheckpointID")
export type AgentCheckpointID = z.infer<typeof AgentCheckpointIDSchema>

export const SessionBindingIDSchema = id("SessionBindingID")
export type SessionBindingID = z.infer<typeof SessionBindingIDSchema>

export const DecisionIDSchema = id("DecisionID")
export type DecisionID = z.infer<typeof DecisionIDSchema>

export const WorkSourceIDSchema = id("WorkSourceID")
export type WorkSourceID = z.infer<typeof WorkSourceIDSchema>

export const WorkSourceRevisionIDSchema = id("WorkSourceRevisionID")
export type WorkSourceRevisionID = z.infer<typeof WorkSourceRevisionIDSchema>

export const EvidenceIDSchema = id("EvidenceID")
export type EvidenceID = z.infer<typeof EvidenceIDSchema>

export const CompletionRequirementIDSchema = id("CompletionRequirementID")
export type CompletionRequirementID = z.infer<typeof CompletionRequirementIDSchema>

export const ConnectionIDSchema = id("ConnectionID")
export type ConnectionID = z.infer<typeof ConnectionIDSchema>

export const DurableEffectReceiptIDSchema = id("DurableEffectReceiptID")
export type DurableEffectReceiptID = z.infer<typeof DurableEffectReceiptIDSchema>
