import type {
  ExecutionCapabilities,
  ExecutionProfileDefaults,
  OrganizationID,
  OwnerUserID,
  RecapProfileDefaults,
  ResolvedExecutionProfile,
} from "../contracts"
import { isExecutionCapabilityCatalogFresh } from "../contracts"

export type ExecutionProfileCapabilityDiagnosticReason =
  | "organization_mismatch"
  | "owner_mismatch"
  | "catalog_stale"
  | "unsupported_environment"
  | "environment_target_required"
  | "preset_unavailable"
  | "repository_required"
  | "repository_remote_url_required"
  | "unsupported_remote_url"
  | "unsupported_base_revision"
  | "unsupported_harness"
  | "unsupported_agent"
  | "agent_harness_mismatch"
  | "unsupported_model"
  | "model_harness_mismatch"
  | "unsupported_effort"
  | "unsupported_tool"
  | "tool_harness_mismatch"
  | "unsupported_connection"
  | "duplicate_value"
  | "connection_capability_required"
  | "connection_tool_required"

export type ExecutionProfileCapabilityDiagnostic = Readonly<{
  field: "organizationId" | "ownerUserId" | "expiresAt" | keyof ResolvedExecutionProfile
  path: string
  reason: ExecutionProfileCapabilityDiagnosticReason
  message: string
  selected?: string
}>

export type ExecutionProfileCapabilityValidation =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; diagnostics: readonly ExecutionProfileCapabilityDiagnostic[] }>

export function validateExecutionProfileDefaultsAgainstCapabilities(input: Readonly<{
  organizationId: OrganizationID
  ownerUserId: OwnerUserID
  now: number
  capabilities: ExecutionCapabilities
  profile: ExecutionProfileDefaults
}>): ExecutionProfileCapabilityValidation {
  return validate(input, false)
}

export function validateResolvedExecutionProfileAgainstCapabilities(input: Readonly<{
  organizationId: OrganizationID
  ownerUserId: OwnerUserID
  now: number
  capabilities: ExecutionCapabilities
  profile: ResolvedExecutionProfile
}>): ExecutionProfileCapabilityValidation {
  return validate(input, true)
}

export function validateRecapProfileDefaultsAgainstCapabilities(input: Readonly<{
  organizationId: OrganizationID
  ownerUserId: OwnerUserID
  now: number
  capabilities: ExecutionCapabilities
  profile: RecapProfileDefaults
}>): ExecutionProfileCapabilityValidation {
  return validate({
    organizationId: input.organizationId,
    ownerUserId: input.ownerUserId,
    now: input.now,
    capabilities: input.capabilities,
    profile: {
      ...(input.profile.model ? { model: input.profile.model } : {}),
      ...(input.profile.effort ? { effort: input.profile.effort } : {}),
    },
  }, false)
}

function validate(
  input: Readonly<{
    organizationId: OrganizationID
    ownerUserId: OwnerUserID
    now: number
    capabilities: ExecutionCapabilities
    profile: ExecutionProfileDefaults | ResolvedExecutionProfile
  }>,
  resolved: boolean,
): ExecutionProfileCapabilityValidation {
  if (input.capabilities.organizationId !== input.organizationId) {
    return invalid([diagnostic(
      "organizationId",
      "organizationId",
      "organization_mismatch",
      "The execution capability catalog belongs to a different organization",
    )])
  }
  if (input.capabilities.ownerUserId !== input.ownerUserId) {
    return invalid([diagnostic(
      "ownerUserId",
      "ownerUserId",
      "owner_mismatch",
      "The execution capability catalog belongs to a different owner",
    )])
  }
  if (!isExecutionCapabilityCatalogFresh(input.capabilities, input.now)) {
    return invalid([diagnostic(
      "expiresAt",
      "expiresAt",
      "catalog_stale",
      "The execution capability catalog has expired and must be refreshed",
      String(input.capabilities.expiresAt),
    )])
  }

  const diagnostics: ExecutionProfileCapabilityDiagnostic[] = []
  const environment = input.profile.environment
  const environmentCapability = environment
    ? input.capabilities.environments.find((candidate) => candidate.kind === environment.kind)
    : undefined
  if (environment && !environmentCapability) {
    diagnostics.push(diagnostic(
      "environment",
      "environment.kind",
      "unsupported_environment",
      `Execution environment ${environment.kind} is not available`,
      environment.kind,
    ))
  }
  if (environment?.presetId) {
    diagnostics.push(diagnostic(
      "environment",
      "environment.presetId",
      "preset_unavailable",
      "Execution environment presets are not exposed by the capability catalog",
      environment.presetId,
    ))
  }
  if (resolved && environment && !(
    environment.kind === "local_worktree" ? environment.directory?.trim() : environment.repositoryUrl?.trim()
  )) {
    diagnostics.push(diagnostic(
      "environment",
      environment.kind === "local_worktree" ? "environment.directory" : "environment.repositoryUrl",
      "environment_target_required",
      environment.kind === "local_worktree"
        ? "A local Worktree environment requires the Stream's project directory"
        : "A hosted Workspace environment requires the Stream's GitHub repository URL",
    ))
  }

  validateRepository(input, resolved, environmentCapability, diagnostics)
  validateHarnessSelections(input, diagnostics)
  validateToolsAndConnections(input, resolved, diagnostics)

  return diagnostics.length > 0 ? invalid(diagnostics) : { ok: true }
}

function validateRepository(
  input: Readonly<{
    capabilities: ExecutionCapabilities
    profile: ExecutionProfileDefaults | ResolvedExecutionProfile
  }>,
  resolved: boolean,
  environment: ExecutionCapabilities["environments"][number] | undefined,
  diagnostics: ExecutionProfileCapabilityDiagnostic[],
) {
  const repository = input.profile.repository
  if (resolved && environment?.repositoryRequired && !repository) {
    diagnostics.push(diagnostic(
      "repository",
      "repository",
      "repository_required",
      `Execution environment ${environment.kind} requires a repository target`,
    ))
  }
  if (!repository) return

  if (
    resolved &&
    environment?.kind === "hosted_workspace" &&
    input.profile.environment?.kind === "hosted_workspace" &&
    !input.profile.environment.repositoryUrl &&
    !repository.remoteUrl
  ) {
    diagnostics.push(diagnostic(
      "repository",
      "repository.remoteUrl",
      "repository_remote_url_required",
      "A hosted repository target requires an explicit remote URL",
    ))
  }

  const environments = environment ? [environment] : input.capabilities.environments
  const remoteUrl = input.profile.environment?.kind === "hosted_workspace"
    ? input.profile.environment.repositoryUrl ?? repository.remoteUrl
    : repository.remoteUrl
  if (remoteUrl && !environments.some((candidate) =>
    candidate.remoteUrlInput || input.capabilities.repository.remoteUrl === remoteUrl)) {
    diagnostics.push(diagnostic(
      "repository",
      "repository.remoteUrl",
      "unsupported_remote_url",
      "The selected repository remote URL is not accepted by the execution environment",
      remoteUrl,
    ))
  }
  if (!environments.some((candidate) =>
    candidate.baseRevisionInput || input.capabilities.repository.baseRevisions.includes(repository.baseRevision))) {
    diagnostics.push(diagnostic(
      "repository",
      "repository.baseRevision",
      "unsupported_base_revision",
      `Repository base revision ${repository.baseRevision} is not available`,
      repository.baseRevision,
    ))
  }
}

function validateHarnessSelections(
  input: Readonly<{
    capabilities: ExecutionCapabilities
    profile: ExecutionProfileDefaults | ResolvedExecutionProfile
  }>,
  diagnostics: ExecutionProfileCapabilityDiagnostic[],
) {
  const harness = input.profile.harness
  if (harness && !input.capabilities.harnesses.some((candidate) => candidate.id === harness)) {
    diagnostics.push(diagnostic(
      "harness",
      "harness",
      "unsupported_harness",
      `Execution harness ${harness} is not available`,
      harness,
    ))
  }

  const agent = input.profile.agent
  const matchingAgents = agent
    ? input.capabilities.agents.filter((candidate) => candidate.id === agent)
    : []
  if (agent && matchingAgents.length === 0) {
    diagnostics.push(diagnostic("agent", "agent", "unsupported_agent", `Agent ${agent} is not available`, agent))
  } else if (agent && harness && !matchingAgents.some((candidate) => candidate.harnessId === harness)) {
    diagnostics.push(diagnostic(
      "agent",
      "agent",
      "agent_harness_mismatch",
      `Agent ${agent} is not available for harness ${harness}`,
      agent,
    ))
  }

  const model = input.profile.model
  const matchingModels = model
    ? input.capabilities.models.filter((candidate) =>
        candidate.providerId === model.providerId && candidate.modelId === model.modelId)
    : []
  const selectedModel = model ? `${model.providerId}/${model.modelId}` : undefined
  if (model && matchingModels.length === 0) {
    diagnostics.push(diagnostic(
      "model",
      "model",
      "unsupported_model",
      `Model ${selectedModel} is not available`,
      selectedModel,
    ))
  } else if (model && harness && !matchingModels.some((candidate) => candidate.harnessId === harness)) {
    diagnostics.push(diagnostic(
      "model",
      "model",
      "model_harness_mismatch",
      `Model ${selectedModel} is not available for harness ${harness}`,
      selectedModel,
    ))
  }

  const effort = input.profile.effort
  if (!effort) return
  const effortModels = model
    ? matchingModels.filter((candidate) => !harness || candidate.harnessId === harness)
    : input.capabilities.models.filter((candidate) => !harness || candidate.harnessId === harness)
  if (!effortModels.some((candidate) => candidate.efforts.includes(effort))) {
    diagnostics.push(diagnostic(
      "effort",
      "effort",
      "unsupported_effort",
      model
        ? `Effort ${effort} is not available for model ${selectedModel}`
        : `Effort ${effort} is not available for the selected execution harness`,
      effort,
    ))
  }
}

function validateToolsAndConnections(
  input: Readonly<{
    capabilities: ExecutionCapabilities
    profile: ExecutionProfileDefaults | ResolvedExecutionProfile
  }>,
  resolved: boolean,
  diagnostics: ExecutionProfileCapabilityDiagnostic[],
) {
  const tools = input.profile.tools
  const connectionIds = input.profile.connectionIds
  if (tools) validateUnique("tools", tools, diagnostics)
  if (connectionIds) validateUnique("connectionIds", connectionIds, diagnostics)

  const matchingTools = (tools ?? []).flatMap((tool, index) => {
    const matches = input.capabilities.tools.filter((candidate) => candidate.id === tool)
    if (matches.length === 0) {
      diagnostics.push(diagnostic(
        "tools",
        `tools[${index}]`,
        "unsupported_tool",
        `Tool ${tool} is not available`,
        tool,
      ))
      return []
    }
    if (input.profile.harness && !matches.some((candidate) => candidate.harnessId === input.profile.harness)) {
      diagnostics.push(diagnostic(
        "tools",
        `tools[${index}]`,
        "tool_harness_mismatch",
        `Tool ${tool} is not available for harness ${input.profile.harness}`,
        tool,
      ))
      return []
    }
    return [{
      capability: input.profile.harness
        ? matches.find((candidate) => candidate.harnessId === input.profile.harness)!
        : matches[0]!,
      index,
    }]
  })

  const connections = (connectionIds ?? []).flatMap((connectionId, index) => {
    const connection = input.capabilities.connections.find((candidate) => candidate.id === connectionId)
    if (connection) return [connection]
    diagnostics.push(diagnostic(
      "connectionIds",
      `connectionIds[${index}]`,
      "unsupported_connection",
      `Connection ${connectionId} is not available for this owner`,
      connectionId,
    ))
    return []
  })

  if ((!resolved && (tools === undefined || connectionIds === undefined)) || !tools || !connectionIds) return
  matchingTools.forEach(({ capability: tool, index }) => {
    if (!tool.requiresConnectionCapability) return
    if (connections.some((connection) => connection.grantedCapabilities.includes(tool.requiresConnectionCapability!))) return
    diagnostics.push(diagnostic(
      "tools",
      `tools[${index}]`,
      "connection_capability_required",
      `Tool ${tool.id} requires a selected Connection granting ${tool.requiresConnectionCapability}`,
      tool.id,
    ))
  })
  if (connectionIds.length > 0 && !matchingTools.some(({ capability }) => capability.requiresConnectionCapability)) {
    diagnostics.push(diagnostic(
      "connectionIds",
      "connectionIds",
      "connection_tool_required",
      "Selected Connections require an explicit connection-capable tool",
    ))
  }
}

function validateUnique(
  field: "tools" | "connectionIds",
  values: readonly string[],
  diagnostics: ExecutionProfileCapabilityDiagnostic[],
) {
  values.forEach((value, index) => {
    if (values.indexOf(value) === index) return
    diagnostics.push(diagnostic(
      field,
      `${field}[${index}]`,
      "duplicate_value",
      `${field === "tools" ? "Tool" : "Connection"} ${value} is selected more than once`,
      value,
    ))
  })
}

function diagnostic(
  field: ExecutionProfileCapabilityDiagnostic["field"],
  path: string,
  reason: ExecutionProfileCapabilityDiagnosticReason,
  message: string,
  selected?: string,
): ExecutionProfileCapabilityDiagnostic {
  return { field, path, reason, message, ...(selected ? { selected } : {}) }
}

function invalid(diagnostics: readonly ExecutionProfileCapabilityDiagnostic[]): ExecutionProfileCapabilityValidation {
  return { ok: false, diagnostics }
}
