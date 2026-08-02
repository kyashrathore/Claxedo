import { z } from "zod"
import { ConnectionIDSchema, OrganizationIDSchema, OwnerUserIDSchema } from "./ids"

const text = z.string().trim().min(1)

/**
 * Maximum lifetime of one exact execution-capability observation. Capability
 * choices originate in live runtimes, repositories, and Connections, so every
 * consumer must re-observe or explicitly refresh them within this window.
 */
export const EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS = 5 * 60_000

export const ExecutionCapabilityCatalogRevisionSchema = z.string().regex(/^[0-9a-f]{64}$/)
export type ExecutionCapabilityCatalogRevision = z.infer<typeof ExecutionCapabilityCatalogRevisionSchema>

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

export const ExecutionCapabilitiesErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.literal("execution_capabilities_unavailable"),
    capability: ExecutionCapabilityNameSchema,
    reason: ExecutionCapabilityUnavailableReasonSchema,
    message: text,
    retryable: z.boolean(),
  }),
})
export type ExecutionCapabilitiesError = z.infer<typeof ExecutionCapabilitiesErrorSchema>

export const ExecutionEnvironmentCapabilitySchema = z.preprocess(
  withoutLegacyPolicies,
  z.strictObject({
    kind: z.enum(["local_worktree", "hosted_workspace"]),
    repositoryRequired: z.boolean(),
    remoteUrlInput: z.boolean(),
    baseRevisionInput: z.boolean(),
  }),
)
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

function withoutLegacyPolicies(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  if (!("cleanup" in value) && !("integration" in value) && !("isolation" in value)) return value
  const result = { ...(value as Record<string, unknown>) }
  delete result.cleanup
  delete result.integration
  delete result.isolation
  return result
}

export const ExecutionCapabilitiesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  organizationId: OrganizationIDSchema,
  ownerUserId: OwnerUserIDSchema,
  catalogRevision: ExecutionCapabilityCatalogRevisionSchema,
  observedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  environments: z.array(ExecutionEnvironmentCapabilitySchema).min(1),
  harnesses: z.array(ExecutionHarnessCapabilitySchema).min(1),
  agents: z.array(ExecutionAgentCapabilitySchema).min(1),
  models: z.array(ExecutionModelCapabilitySchema),
  tools: z.array(ExecutionToolCapabilitySchema).min(1),
  repository: ExecutionRepositoryCapabilitySchema,
  connections: z.array(ExecutionConnectionCapabilitySchema),
}).superRefine((catalog, context) => {
  if (catalog.expiresAt <= catalog.observedAt) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "Execution capability catalog expiry must follow its observation",
    })
  }
  if (catalog.expiresAt - catalog.observedAt > EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "Execution capability catalog lifetime exceeds the freshness contract",
    })
  }
})
export type ExecutionCapabilities = z.infer<typeof ExecutionCapabilitiesSchema>

/** Expiry is exclusive: a catalog is stale at its exact `expiresAt` boundary. */
export function isExecutionCapabilityCatalogFresh(catalog: ExecutionCapabilities, now: number) {
  return now < catalog.expiresAt
}
