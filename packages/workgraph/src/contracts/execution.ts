import { z } from "zod"
import { ConnectionIDSchema } from "./ids"

export const ExecutionEnvironmentSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("local_worktree"), presetId: z.string().trim().min(1).optional() }),
  z.strictObject({ kind: z.literal("hosted_workspace"), presetId: z.string().trim().min(1).optional() }),
])
export type ExecutionEnvironment = z.infer<typeof ExecutionEnvironmentSchema>

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

const executionProfileShape = {
  environment: ExecutionEnvironmentSchema,
  repository: RepositoryTargetSchema.optional(),
  harness: z.string().trim().min(1),
  agent: z.string().trim().min(1),
  model: ModelSelectionSchema,
  effort: z.string().trim().min(1),
  tools: z.array(z.string().trim().min(1)),
  connectionIds: z.array(ConnectionIDSchema),
  isolation: z.enum(["stream", "child"]),
  cleanup: z.enum(["destroy_on_close", "retain"]),
  integration: z.enum(["manual", "pull_request", "direct"]),
}

export const ExecutionProfileDefaultsSchema = z.strictObject(executionProfileShape).partial()
export type ExecutionProfileDefaults = z.infer<typeof ExecutionProfileDefaultsSchema>

export const ResolvedExecutionProfileSchema = z.strictObject(executionProfileShape).readonly().transform(deepFreeze)
export type ResolvedExecutionProfile = z.infer<typeof ResolvedExecutionProfileSchema>

export const ExecutionProfileLevelSchema = z.enum(["workgraph", "stream", "outcome", "work_item"])
export type ExecutionProfileLevel = z.infer<typeof ExecutionProfileLevelSchema>

export const RecapProfileDefaultsSchema = z.strictObject({
  model: ModelSelectionSchema.optional(),
  effort: z.string().trim().min(1).optional(),
  quietHours: z.number().positive().optional(),
})
export type RecapProfileDefaults = z.infer<typeof RecapProfileDefaultsSchema>

export const WorkGraphDefaultsSchema = z.strictObject({
  execution: ExecutionProfileDefaultsSchema,
  recap: RecapProfileDefaultsSchema,
})
export type WorkGraphDefaults = z.infer<typeof WorkGraphDefaultsSchema>

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value
  Object.values(value).forEach(deepFreeze)
  return Object.freeze(value) as T
}
