import { z } from "zod"
import { ConnectionIDSchema, OwnerUserIDSchema } from "./ids"

const text = z.string().trim().min(1)

export const ExecutionCapabilityNameSchema = z.enum([
  "catalog_workspace",
  "runtime",
  "harnesses",
  "agents",
  "models",
  "tools",
  "repository",
  "connections",
])
export type ExecutionCapabilityName = z.infer<typeof ExecutionCapabilityNameSchema>

export const ExecutionCapabilityUnavailableReasonSchema = z.enum([
  "catalog_workspace_unavailable",
  "runtime_unavailable",
  "catalog_invalid",
  "repository_unavailable",
  "connections_unavailable",
])
export type ExecutionCapabilityUnavailableReason = z.infer<typeof ExecutionCapabilityUnavailableReasonSchema>

export const ExecutionEnvironmentCapabilitySchema = z.strictObject({
  kind: z.enum(["local_worktree", "hosted_workspace"]),
  repositoryRequired: z.boolean(),
  remoteUrlInput: z.boolean(),
  baseRevisionInput: z.boolean(),
  isolation: z.array(z.enum(["stream", "child"])),
  cleanup: z.array(z.enum(["destroy_on_close", "retain"])),
  integration: z.array(z.enum(["manual", "pull_request", "direct"])),
})
export type ExecutionEnvironmentCapability = z.infer<typeof ExecutionEnvironmentCapabilitySchema>

export const ExecutionHarnessCapabilitySchema = z.strictObject({
  id: text,
})
export type ExecutionHarnessCapability = z.infer<typeof ExecutionHarnessCapabilitySchema>

export const ExecutionAgentCapabilitySchema = z.strictObject({
  harnessId: text,
  id: text,
  label: text,
  description: text.optional(),
  mode: z.enum(["primary", "subagent", "all"]).optional(),
})
export type ExecutionAgentCapability = z.infer<typeof ExecutionAgentCapabilitySchema>

export const ExecutionModelCapabilitySchema = z.strictObject({
  harnessId: text,
  providerId: text,
  modelId: text,
  label: text,
  efforts: z.array(text),
})
export type ExecutionModelCapability = z.infer<typeof ExecutionModelCapabilitySchema>

export const ExecutionToolCapabilitySchema = z.strictObject({
  harnessId: text,
  id: text,
  description: text.optional(),
  requiresConnectionCapability: text.optional(),
})
export type ExecutionToolCapability = z.infer<typeof ExecutionToolCapabilitySchema>

export const ExecutionRepositoryCapabilitySchema = z.strictObject({
  remoteUrl: text.optional(),
  baseRevisions: z.array(text),
})
export type ExecutionRepositoryCapability = z.infer<typeof ExecutionRepositoryCapabilitySchema>

export const ExecutionConnectionCapabilitySchema = z.strictObject({
  id: ConnectionIDSchema,
  integrationId: text,
  scope: z.enum(["personal", "team"]),
  accountLabel: text.optional(),
  grantedCapabilities: z.array(text),
})
export type ExecutionConnectionCapability = z.infer<typeof ExecutionConnectionCapabilitySchema>

export const ExecutionCapabilitiesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ownerUserId: OwnerUserIDSchema,
  observedAt: z.number().int().nonnegative(),
  environments: z.array(ExecutionEnvironmentCapabilitySchema).min(1),
  harnesses: z.array(ExecutionHarnessCapabilitySchema).min(1),
  agents: z.array(ExecutionAgentCapabilitySchema).min(1),
  models: z.array(ExecutionModelCapabilitySchema),
  tools: z.array(ExecutionToolCapabilitySchema).min(1),
  repository: ExecutionRepositoryCapabilitySchema,
  connections: z.array(ExecutionConnectionCapabilitySchema),
})
export type ExecutionCapabilities = z.infer<typeof ExecutionCapabilitiesSchema>
