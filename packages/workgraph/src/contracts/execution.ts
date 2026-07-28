import { z } from "zod"
import { ConnectionIDSchema } from "./ids"

export const ExecutionEnvironmentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("local_worktree"),
    directory: z.string().trim().min(1).optional(),
    presetId: z.string().trim().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("hosted_workspace"),
    repositoryUrl: z.string().url().optional(),
    presetId: z.string().trim().min(1).optional(),
  }),
])
export type ExecutionEnvironment = z.infer<typeof ExecutionEnvironmentSchema>

export function executionEnvironmentHasTarget(environment: ExecutionEnvironment) {
  if (environment.kind === "local_worktree") return !!environment.directory?.trim()
  return !!environment.repositoryUrl?.trim()
}

export const RepositoryTargetSchema = z.strictObject({
  remoteUrl: z.string().url().optional(),
  baseRevision: z.string().trim().min(1),
})
export type RepositoryTarget = z.infer<typeof RepositoryTargetSchema>

export const ModelSelectionSchema = z.strictObject({
  providerId: z.string().trim().min(1),
  modelId: z.string().trim().min(1),
})
export type ModelSelection = z.infer<typeof ModelSelectionSchema>

const generationProfileShape = {
  harness: z.string().trim().min(1),
  agent: z.string().trim().min(1),
  model: ModelSelectionSchema,
  effort: z.string().trim().min(1),
  tools: z.array(z.string().trim().min(1)),
  connectionIds: z.array(ConnectionIDSchema),
}

const executionProfileShape = {
  environment: ExecutionEnvironmentSchema,
  repository: RepositoryTargetSchema.optional(),
  ...generationProfileShape,
}

/** Session generation selects a harness/model but does not own Task placement. */
export const ResolvedGenerationProfileSchema = z.preprocess(
  withoutExecutionTarget,
  z.strictObject(generationProfileShape).readonly(),
).overwrite(deepFreeze)
export type ResolvedGenerationProfile = z.infer<typeof ResolvedGenerationProfileSchema>

const AgentProfileNameSchema = z.string().trim().min(1).max(64)

export const AgentProfileSchema = z.strictObject({
  name: AgentProfileNameSchema,
  brief: z.string().max(2_000),
  generation: ResolvedGenerationProfileSchema,
  memoryRef: z.string().optional(),
})
export type AgentProfile = z.infer<typeof AgentProfileSchema>

export const ExecutionProfileDefaultsSchema = z.preprocess(
  withoutLegacyPolicies,
  z.strictObject({
    ...executionProfileShape,
    agents: z.array(AgentProfileSchema),
    assignments: z.strictObject({
      planning: AgentProfileNameSchema.optional(),
      execution: AgentProfileNameSchema.optional(),
      review: AgentProfileNameSchema.optional(),
    }),
  }).partial(),
)
export type ExecutionProfileDefaults = z.infer<typeof ExecutionProfileDefaultsSchema>

export const ResolvedExecutionProfileSchema = z.preprocess(
  withoutDefaultsMetadata,
  z.strictObject(executionProfileShape).readonly(),
).transform(deepFreeze)
export type ResolvedExecutionProfile = z.infer<typeof ResolvedExecutionProfileSchema>

export const ExecutionProfileLevelSchema = z.enum(["workgraph", "stream", "outcome", "work_item"])
export type ExecutionProfileLevel = z.infer<typeof ExecutionProfileLevelSchema>

export const WorkGraphDefaultsSchema = z.strictObject({
  execution: ExecutionProfileDefaultsSchema,
})
export type WorkGraphDefaults = z.infer<typeof WorkGraphDefaultsSchema>

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value
  Object.values(value).forEach(deepFreeze)
  return Object.freeze(value) as T
}

function withoutLegacyPolicies(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  if (!("cleanup" in value) && !("integration" in value) && !("isolation" in value)) return value
  const result = { ...(value as Record<string, unknown>) }
  delete result.cleanup
  delete result.integration
  delete result.isolation
  return result
}

function withoutExecutionTarget(value: unknown) {
  const result = withoutLegacyPolicies(value)
  if (!result || typeof result !== "object" || Array.isArray(result)) return result
  const generation = { ...(result as Record<string, unknown>) }
  delete generation.environment
  delete generation.repository
  return generation
}

function withoutDefaultsMetadata(value: unknown) {
  const result = withoutLegacyPolicies(value)
  if (!result || typeof result !== "object" || Array.isArray(result)) return result
  const execution = { ...(result as Record<string, unknown>) }
  delete execution.agents
  delete execution.assignments
  return execution
}
