import { describe, expect, it } from "vitest"
import {
  ConnectionIDSchema,
  EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS,
  ExecutionCapabilitiesSchema,
  ExecutionProfileDefaultsSchema,
  OrganizationIDSchema,
  OwnerUserIDSchema,
  ResolvedExecutionProfileSchema,
  type ExecutionCapabilities,
  type ExecutionProfileDefaults,
  type ResolvedExecutionProfile,
} from "../src/contracts"
import {
  validateExecutionProfileDefaultsAgainstCapabilities,
  validateResolvedExecutionProfileAgainstCapabilities,
  type ExecutionProfileCapabilityDiagnosticReason,
  type ExecutionProfileCapabilityValidation,
} from "../src/domain/execution-capability-policy"

const ownerUserId = OwnerUserIDSchema.parse("user_1")
const organizationId = OrganizationIDSchema.parse("organization_1")
const observedAt = 1_000
const capabilities = ExecutionCapabilitiesSchema.parse({
  schemaVersion: 1,
  organizationId,
  ownerUserId,
  catalogRevision: "a".repeat(64),
  observedAt,
  expiresAt: observedAt + EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS,
  environments: [
    {
      kind: "local_worktree",
      repositoryRequired: true,
      remoteUrlInput: false,
      baseRevisionInput: true,
    },
    {
      kind: "hosted_workspace",
      repositoryRequired: false,
      remoteUrlInput: true,
      baseRevisionInput: true,
    },
  ],
  harnesses: [{ id: "codex" }, { id: "pi" }],
  agents: [
    { harnessId: "codex", id: "build", label: "Build" },
    { harnessId: "pi", id: "plan", label: "Plan" },
  ],
  models: [
    { harnessId: "codex", providerId: "openai", modelId: "gpt-5", label: "GPT-5", efforts: ["medium", "high"] },
    { harnessId: "codex", providerId: "anthropic", modelId: "claude", label: "Claude", efforts: [] },
    { harnessId: "pi", providerId: "openai", modelId: "gpt-5", label: "GPT-5", efforts: ["low"] },
  ],
  tools: [
    { harnessId: "codex", id: "read" },
    { harnessId: "codex", id: "connection_work_source_list", requiresConnectionCapability: "work-source" },
    { harnessId: "pi", id: "inspect" },
  ],
  repository: {
    remoteUrl: "https://github.com/claxedo/claxedo.git",
    baseRevisions: ["HEAD", "dev"],
  },
  connections: [
    { id: ConnectionIDSchema.parse("connection_work"), integrationId: "github", scope: "team", grantedCapabilities: ["work-source"] },
    { id: ConnectionIDSchema.parse("connection_issues"), integrationId: "linear", scope: "team", grantedCapabilities: ["issues"] },
  ],
})

const profile = ResolvedExecutionProfileSchema.parse({
  environment: { kind: "local_worktree", directory: "/repo" },
  repository: { baseRevision: "dev" },
  harness: "codex",
  agent: "build",
  model: { providerId: "openai", modelId: "gpt-5" },
  effort: "high",
  tools: ["read"],
  connectionIds: [],
})

describe("ExecutionProfileCapabilityPolicy", () => {
  it("accepts exact partial and resolved selections without filling omitted values", () => {
    expect(validateDefaults({ agent: "build", tools: ["read"] })).toEqual({ ok: true })
    expect(validateResolved(profile)).toEqual({ ok: true })
  })

  it("strips retired lifecycle and integration policies from legacy capability catalogs", () => {
    const legacy = ExecutionCapabilitiesSchema.parse({
      ...capabilities,
      environments: capabilities.environments.map((environment) => ({
        ...environment,
        cleanup: ["destroy_on_close"],
        integration: ["manual"],
        isolation: ["child"],
      })),
    })
    expect(legacy.environments.every((environment) => !("cleanup" in environment))).toBe(true)
    expect(legacy.environments.every((environment) => !("integration" in environment))).toBe(true)
    expect(legacy.environments.every((environment) => !("isolation" in environment))).toBe(true)
  })

  it.each([
    ["environment", { environment: { kind: "hosted_workspace" } }, localOnly(), "unsupported_environment"],
    ["preset", { environment: { kind: "local_worktree", presetId: "fast" } }, capabilities, "preset_unavailable"],
    ["harness", { harness: "ghost" }, capabilities, "unsupported_harness"],
    ["agent", { agent: "ghost" }, capabilities, "unsupported_agent"],
    ["agent harness", { harness: "codex", agent: "plan" }, capabilities, "agent_harness_mismatch"],
    ["model", { model: { providerId: "openai", modelId: "missing" } }, capabilities, "unsupported_model"],
    ["model harness", { harness: "pi", model: { providerId: "anthropic", modelId: "claude" } }, capabilities, "model_harness_mismatch"],
    ["effort on another harness", { harness: "codex", model: { providerId: "openai", modelId: "gpt-5" }, effort: "low" }, capabilities, "unsupported_effort"],
    ["effort", { model: { providerId: "openai", modelId: "gpt-5" }, effort: "maximum" }, capabilities, "unsupported_effort"],
    ["empty model efforts", { model: { providerId: "anthropic", modelId: "claude" }, effort: "high" }, capabilities, "unsupported_effort"],
    ["tool", { tools: ["missing"] }, capabilities, "unsupported_tool"],
    ["tool harness", { harness: "pi", tools: ["read"] }, capabilities, "tool_harness_mismatch"],
    ["connection", { connectionIds: ["connection_missing"] }, capabilities, "unsupported_connection"],
    ["duplicate tools", { tools: ["read", "read"] }, capabilities, "duplicate_value"],
    ["duplicate Connections", { connectionIds: ["connection_work", "connection_work"] }, capabilities, "duplicate_value"],
  ] satisfies readonly [string, Record<string, unknown>, ExecutionCapabilities, ExecutionProfileCapabilityDiagnosticReason][])(
    "rejects unsupported partial %s selections",
    (_name, selected, catalog, reason) => {
      expect(reasons(validateDefaults(selected, catalog))).toContain(reason)
    },
  )

  it("checks connection requirements only when both sides of a partial override are known", () => {
    expect(validateDefaults({ tools: ["connection_work_source_list"] })).toEqual({ ok: true })
    expect(validateDefaults({ connectionIds: ["connection_work"] })).toEqual({ ok: true })
    expect(reasons(validateDefaults({
      tools: ["connection_work_source_list"],
      connectionIds: ["connection_issues"],
    }))).toContain("connection_capability_required")
    expect(reasons(validateDefaults({ tools: ["read"], connectionIds: ["connection_work"] })))
      .toContain("connection_tool_required")
    expect(validateDefaults({
      tools: ["connection_work_source_list"],
      connectionIds: ["connection_work"],
    })).toEqual({ ok: true })
  })

  it("enforces repository requirements and explicit hosted repository identity", () => {
    const withoutRepository = ResolvedExecutionProfileSchema.parse({
      environment: { kind: "local_worktree" },
      harness: "codex",
      agent: "build",
      model: { providerId: "openai", modelId: "gpt-5" },
      effort: "high",
      tools: ["read"],
      connectionIds: [],
    })
    expect(reasons(validateResolved(withoutRepository))).toContain("repository_required")

    const hostedWithoutRemote = ResolvedExecutionProfileSchema.parse({
      ...profile,
      environment: { kind: "hosted_workspace" },
      repository: { baseRevision: "dev" },
    })
    expect(reasons(validateResolved(hostedWithoutRemote))).toContain("repository_remote_url_required")
  })

  it("accepts explicit repository input and otherwise requires the catalog's exact fixed values", () => {
    expect(validateDefaults({
      environment: { kind: "hosted_workspace" },
      repository: { remoteUrl: "https://example.com/new.git", baseRevision: "feature/new" },
    })).toEqual({ ok: true })

    const fixed = withEnvironment(capabilities, {
      kind: "local_worktree",
      repositoryRequired: true,
      remoteUrlInput: false,
      baseRevisionInput: false,
    })
    expect(validateDefaults({
      environment: { kind: "local_worktree" },
      repository: { remoteUrl: "https://github.com/claxedo/claxedo.git", baseRevision: "dev" },
    }, fixed)).toEqual({ ok: true })
    expect(reasons(validateDefaults({
      environment: { kind: "local_worktree" },
      repository: { remoteUrl: "https://example.com/other.git", baseRevision: "missing" },
    }, fixed))).toEqual(expect.arrayContaining(["unsupported_remote_url", "unsupported_base_revision"]))
  })

  it("rejects a catalog from another owner without evaluating its contents", () => {
    const other = ExecutionCapabilitiesSchema.parse({ ...capabilities, ownerUserId: "user_2" })
    const result = validateDefaults({ harness: "ghost" }, other)
    expect(result).toEqual({
      ok: false,
      diagnostics: [{
        field: "ownerUserId",
        path: "ownerUserId",
        reason: "owner_mismatch",
        message: "The execution capability catalog belongs to a different owner",
      }],
    })
  })

  it("rejects a catalog from another organization before evaluating its contents", () => {
    const other = ExecutionCapabilitiesSchema.parse({ ...capabilities, organizationId: "organization_2" })
    expect(validateDefaults({ harness: "ghost" }, other)).toEqual({
      ok: false,
      diagnostics: [{
        field: "organizationId",
        path: "organizationId",
        reason: "organization_mismatch",
        message: "The execution capability catalog belongs to a different organization",
      }],
    })
  })

  it("rejects an expired catalog at the exact exclusive expiry boundary", () => {
    expect(reasons(validateDefaults({ harness: "codex" }, capabilities, capabilities.expiresAt - 1))).toEqual([])
    expect(reasons(validateDefaults({ harness: "codex" }, capabilities, capabilities.expiresAt))).toEqual(["catalog_stale"])
  })

  it("returns stable diagnostics that can be attached to validation_error details", () => {
    const result = validateResolved(ResolvedExecutionProfileSchema.parse({
      ...profile,
      environment: { kind: "hosted_workspace", repositoryUrl: "https://example.com/repo.git", presetId: "unknown" },
      repository: { remoteUrl: "https://example.com/repo.git", baseRevision: "main" },
    }))
    expect(result).toMatchObject({ ok: false })
    if (result.ok) throw new Error("Expected capability diagnostics")
    expect(result.diagnostics.map((item) => ({ field: item.field, path: item.path, reason: item.reason }))).toEqual([
      { field: "environment", path: "environment.presetId", reason: "preset_unavailable" },
    ])
  })
})

function validateDefaults(
  selected: Record<string, unknown>,
  catalog: ExecutionCapabilities = capabilities,
  now = observedAt,
) {
  return validateExecutionProfileDefaultsAgainstCapabilities({
    organizationId,
    ownerUserId,
    now,
    capabilities: catalog,
    profile: ExecutionProfileDefaultsSchema.parse(selected),
  })
}

function validateResolved(selected: ResolvedExecutionProfile) {
  return validateResolvedExecutionProfileAgainstCapabilities({ organizationId, ownerUserId, now: observedAt, capabilities, profile: selected })
}

function reasons(result: ExecutionProfileCapabilityValidation) {
  return result.ok ? [] : result.diagnostics.map((item) => item.reason)
}

function localOnly() {
  return ExecutionCapabilitiesSchema.parse({
    ...capabilities,
    environments: capabilities.environments.filter((environment) => environment.kind === "local_worktree"),
  })
}

function withEnvironment(
  catalog: ExecutionCapabilities,
  environment: ExecutionCapabilities["environments"][number],
) {
  return ExecutionCapabilitiesSchema.parse({
    ...catalog,
    environments: [environment, ...catalog.environments.filter((candidate) => candidate.kind !== environment.kind)],
  })
}
