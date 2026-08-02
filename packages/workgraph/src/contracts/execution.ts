import { z } from "zod"
import { ConnectionIDSchema } from "./ids"

export const ExecutionPlacementSchema = z.enum(["shared", "worktree", "sandbox"])
export type ExecutionPlacement = z.infer<typeof ExecutionPlacementSchema>

export const ExecutionEnvironmentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("local_worktree"),
    placement: ExecutionPlacementSchema.default("shared"),
    directory: z.string().trim().min(1).optional(),
    presetId: z.string().trim().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("hosted_workspace"),
    placement: ExecutionPlacementSchema.default("shared"),
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

export const StreamProfileSpendSchema = z.strictObject({
  profile: z.string().trim().min(1),
  totalUsd: z.number().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative(),
})
export type StreamProfileSpend = z.infer<typeof StreamProfileSpendSchema>

export const StreamSpendSchema = z.strictObject({
  totalUsd: z.number().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative(),
  byProfile: z.array(StreamProfileSpendSchema).default([]),
  asOf: z.number().int().nonnegative(),
  asOfMessageId: z.string().optional(),
  dayStart: z.number().int().nonnegative().optional(),
  dayUsd: z.number().nonnegative().optional(),
  dayTokens: z.number().int().nonnegative().optional(),
})
export type StreamSpend = z.infer<typeof StreamSpendSchema>

/** USD per one million tokens. Unknown models remain token-metered. */
export const MODEL_PRICES: Readonly<
  Record<string, Readonly<{ input: number; output: number; reasoning?: number; cacheRead?: number; cacheWrite?: number }>>
> = deepFreeze({
  "openai/gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  "openai/gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
  "anthropic/claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "anthropic/claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "google/gemini-2.5-pro": { input: 1.25, output: 10 },
  "google/gemini-2.5-flash": { input: 0.3, output: 2.5 },
})

export function modelUsageCostUsd(input: Readonly<{
  providerId: string
  modelId: string
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}>) {
  const price = MODEL_PRICES[`${input.providerId}/${input.modelId}`]
  if (!price) return undefined
  return (
    input.inputTokens * price.input +
    input.outputTokens * price.output +
    input.reasoningTokens * (price.reasoning ?? price.output) +
    input.cacheReadTokens * (price.cacheRead ?? price.input) +
    input.cacheWriteTokens * (price.cacheWrite ?? price.input)
  ) / 1_000_000
}

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
  /** Carried as durable profile metadata until the MemoryBackend mount is wired. */
  memoryRef: z.string().optional(),
})
export type AgentProfile = z.infer<typeof AgentProfileSchema>

export const ExecutionBudgetSchema = z.strictObject({
  amount: z.number().positive(),
  unit: z.enum(["usd", "tokens"]),
  window: z.enum(["day", "stream"]),
})
export type ExecutionBudget = z.infer<typeof ExecutionBudgetSchema>

const executionProfileDefaultsObjectSchema = z.strictObject({
  ...executionProfileShape,
  autonomy: z.enum(["supervised", "autonomous"]),
  budget: ExecutionBudgetSchema,
  maxParallel: z.number().int().min(1).max(16),
  mayPromote: z.boolean(),
  agents: z.array(AgentProfileSchema),
  assignments: z.strictObject({
    planning: AgentProfileNameSchema.optional(),
    execution: AgentProfileNameSchema.optional(),
    review: AgentProfileNameSchema.optional(),
  }),
}).partial()

export const ExecutionProfileDefaultsSchema = z.preprocess(
  withoutLegacyPolicies,
  executionProfileDefaultsObjectSchema,
)
export type ExecutionProfileDefaults = z.infer<typeof ExecutionProfileDefaultsSchema>

export const ResolvedExecutionProfileSchema = z.preprocess(
  withoutDefaultsMetadata,
  z.strictObject(executionProfileShape).readonly(),
).transform(deepFreeze)
export type ResolvedExecutionProfile = z.infer<typeof ResolvedExecutionProfileSchema>

export function resolvedPlacement(placement: ExecutionPlacement | null | undefined): ExecutionPlacement {
  return placement ?? "shared"
}

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
  Object.keys(executionProfileDefaultsObjectSchema.shape)
    .filter((key) => !(key in executionProfileShape))
    .forEach((key) => delete execution[key])
  return execution
}
