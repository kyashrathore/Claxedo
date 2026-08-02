import os from "os"
import {
  AgentExtensionMaterializationError,
  agentExtensionStateRoot,
  isHarnessTarget,
  installedStatePath,
  materializedRecordPath,
  parsePackageSource,
  readDesiredExtensionState,
  readMaterializedRuntimeRecord,
  sameSource,
} from "@claxedo/agent-extensions"
import { loadAgentExtensionsCatalog } from "../../hosts/agent-extensions/catalog"
import type { ControlPlaneServices } from "../../authority/services"
import { requireAuthority } from "../../platform/auth/authority"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
} from "../../platform/auth/auth"
import { dataDir } from "../../platform/runtime/lib/paths"
import {
  AgentExtensionConflictError,
  installGitHubAgentExtension,
  updateAgentExtension,
  type AgentExtensionLifecycleInput,
} from "../../hosts/agent-extensions/install"
import {
  readMirroredWorkspaceAgentExtensions,
  resolveGitHubWorkspaceAgentExtension,
  workspaceAgentExtensionRecords,
  type WorkspaceAgentExtensionRecord,
} from "../../hosts/agent-extensions/workspace"
import {
  resolveEffectiveAgentExtensionPolicy,
  type AgentExtensionPolicyOverride,
} from "../../hosts/agent-extensions/runtime-config"
import { syncWorkspaceRuntimeAgentExtensions } from "../../workspace/supervisor"
import { syncEmbeddedWorkspaceRuntimeAgentExtensions } from "../../deployments/local/embedded-workspace-runtime"
import { errorBody } from "../http"

type WorkspaceExtensionScope = {
  id: ""
  scope: "workspace"
  workspaceId: string
  auth: SignedControlPlaneAuth
  services: ControlPlaneServices
}

class AgentExtensionInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export type AgentConfigRouteOptions = {
  installGitHubAgentExtension?: typeof installGitHubAgentExtension
  updateAgentExtension?: typeof updateAgentExtension
  resolveGitHubWorkspaceAgentExtension?: typeof resolveGitHubWorkspaceAgentExtension
  agentExtensionPolicyOverrides?: AgentExtensionPolicyOverride[] | ((input: {
    scope: "project" | "machine" | "workspace"
    directory?: string
    workspaceId?: string
    auth?: SignedControlPlaneAuth
  }) => AgentExtensionPolicyOverride[] | Promise<AgentExtensionPolicyOverride[]>)
  services?: ControlPlaneServices
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  homeDir?: string
  updateCentralSessionModel?: (sessionId: string, model: { providerID: string; modelID: string }) => Promise<void>
  invalidateCentralSession?: (sessionId: string) => void
}

function errorResponse(status: number, code: string, message: string, details?: Record<string, unknown>) {
  return Response.json(errorBody(code, message, details), { status })
}

export function extensionScope(input: {
  scope?: string | null
  directory?: string | null
  homeDir?: string
}): AgentExtensionLifecycleInput | Response {
  const scope = input.scope ?? "project"
  if (scope !== "project" && scope !== "machine") {
    return errorResponse(400, "agent_extension_scope_invalid", "scope must be project or machine")
  }
  if (scope === "project" && !input.directory) {
    return errorResponse(400, "agent_extension_project_directory_required", "directory is required for project Agent Extensions")
  }
  return {
    id: "",
    scope,
    ...(input.directory ? { projectDir: input.directory } : {}),
    dataRoot: dataDir(),
    homeDir: input.homeDir ?? os.homedir(),
  }
}

export async function workspaceExtensionScope(input: {
  request: Request
  workspaceId?: string | null
  services?: ControlPlaneServices
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
}): Promise<WorkspaceExtensionScope | Response> {
  if (!input.workspaceId) return errorResponse(400, "agent_extension_workspace_id_required", "workspaceId is required for workspace Agent Extensions")
  try {
    // Canonical authority guard; its ControlPlaneAuthError maps to this
    // route's Response shape in the catch below.
    const authority = requireAuthority(input.services)
    const context = await controlPlaneAuthContext(input.request, {
      config: input.authConfig,
      verifier: input.verifier,
    })
    if (context.mode !== "signed") {
      return Response.json(controlPlaneAuthErrorBody(new ControlPlaneAuthError(503, "signed_cloud_auth_disabled", context.reason)), { status: 503 })
    }
    await authority.usersMe(context)
    return {
      id: "",
      scope: "workspace",
      workspaceId: input.workspaceId,
      auth: context,
      // `requireAuthority` succeeding above proves services is present.
      services: input.services as ControlPlaneServices,
    }
  } catch (err) {
    if (err instanceof ControlPlaneAuthError) return Response.json(controlPlaneAuthErrorBody(err), { status: err.status })
    throw err
  }
}

export function workspaceExtensionError(err: unknown) {
  if (err instanceof AgentExtensionInputError) {
    return errorResponse(400, err.code, err.message)
  }
  if (err instanceof ControlPlaneAuthError) {
    return Response.json(controlPlaneAuthErrorBody(err), { status: err.status })
  }
  if (err instanceof AgentExtensionConflictError) {
    return Response.json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    }, { status: 409 })
  }
  const message = err instanceof Error ? err.message : String(err)
  if (message === "Workspace not found") {
    return errorResponse(404, "workspace_not_found", message)
  }
  if (message === "Agent Extension not found") {
    return errorResponse(404, "agent_extension_not_found", message)
  }
}

export function localExtensionError(err: unknown) {
  if (err instanceof AgentExtensionInputError) {
    return errorResponse(400, err.code, err.message)
  }
  if (err instanceof AgentExtensionConflictError) {
    return Response.json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    }, { status: 409 })
  }
  if (err instanceof AgentExtensionMaterializationError) {
    return Response.json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    }, { status: err.code.endsWith("_conflict") ? 409 : 400 })
  }
}

export async function mirroredWorkspaceExtensionListBody(options: AgentConfigRouteOptions, workspaceId: string) {
  const installs = await readMirroredWorkspaceAgentExtensions({ workspaceId })
  return extensionListBody(
    {
      version: 1 as const,
      installs: installs.map((item) => item.desired),
    },
    { version: 1, packages: {} },
    await agentExtensionPolicyOverrides(options, { scope: "workspace", workspaceId }),
  )
}

export async function syncWorkspaceRuntimeForSignedScope(scope: WorkspaceExtensionScope) {
  const [installs, policyOverrides] = await Promise.all([
    scope.services.authority!.listWorkspaceAgentExtensions(scope.auth, {
      workspaceId: scope.workspaceId,
    }),
    agentExtensionPolicyOverrides({ services: scope.services }, {
      scope: "workspace",
      workspaceId: scope.workspaceId,
      auth: scope.auth,
    }),
  ])
  const records = workspaceAgentExtensionRecords(installs)
  await Promise.all([
    syncWorkspaceRuntimeAgentExtensions(scope.workspaceId, records, { policyOverrides }),
    syncEmbeddedWorkspaceRuntimeAgentExtensions(scope.workspaceId, records, { policyOverrides }),
  ])
}

// Installs are pinned to the catalog id, but records persisted before the pin
// are keyed by the fetched package's own manifest name / directory basename
// (`anthropic-skill-pdf` -> `pdf`, `mcp-filesystem` -> `filesystem`,
// `mcp-fetch` -> `fetch`). The lifecycle routes only receive an id, so hand the
// package the catalog entry's source alongside it: that is the exact key it
// needs to resolve a legacy record to the id the caller asked for. Unknown ids
// (anything not in the catalog) simply carry no source and resolve as before.
export function catalogSourceFor(id: string) {
  try {
    const entry = loadAgentExtensionsCatalog().entries.find((item) => item.id === id)
    return entry ? parsePackageSource(entry.source) : undefined
  } catch {
    return undefined
  }
}

/**
 * Find the workspace record for the same source persisted under a different
 * id — the workspace-scope counterpart of `legacyInstallId` on the local
 * install path. Installs are pinned to the catalog id, but records persisted
 * before the pin are keyed by the fetched package's manifest name / directory
 * basename, so a pinned install must absorb such a record instead of filing a
 * second row beside it (two records of one source are never two installs).
 */
export function legacyWorkspaceExtensionRecord(
  records: WorkspaceAgentExtensionRecord[],
  input: { id: string; source: WorkspaceAgentExtensionRecord["desired"]["source"] },
) {
  return records.find((item) => item.desired.id !== input.id && sameSource(item.desired.source, input.source))
}

/**
 * Resolve the stored id a workspace lifecycle route should act on when the
 * requested id has no record of its own: when the catalog knows the id, a
 * legacy record for that same source answers to it too (`resolveInstallId` on
 * the local path). Returns undefined when there is nothing to resolve, so the
 * caller keeps its own not-found semantics for the requested id.
 */
export async function legacyWorkspaceExtensionRecordId(
  scope: WorkspaceExtensionScope,
  id: string,
) {
  const source = catalogSourceFor(id)
  if (!source) return undefined
  const records = workspaceAgentExtensionRecords(await scope.services.authority!.listWorkspaceAgentExtensions(scope.auth, {
    workspaceId: scope.workspaceId,
  }))
  if (records.some((item) => item.desired.id === id)) return undefined
  return legacyWorkspaceExtensionRecord(records, { id, source })?.desired.id
}

export function withId(input: AgentExtensionLifecycleInput, id: string): AgentExtensionLifecycleInput {
  const source = catalogSourceFor(id)
  return {
    ...input,
    id,
    ...(source ? { source } : {}),
  }
}

export function extensionTargets(input: unknown) {
  if (input === undefined) return undefined
  if (!Array.isArray(input)) throw new AgentExtensionInputError("agent_extension_targets_invalid", "targets must be an array")
  const targets = input.filter(isHarnessTarget)
  if (targets.length !== input.length) {
    throw new AgentExtensionInputError("agent_extension_targets_invalid", "targets must contain only opencode, claude, codex, or cursor")
  }
  return targets
}

export function extensionSourceInput(input: { type: string; owner?: string; repo?: string; ref?: string; package_path?: string }) {
  if (input.type !== "github" || !input.owner || !input.repo) {
    throw new AgentExtensionInputError("agent_extension_source_unsupported", "Unsupported Agent Extension source")
  }
  const ref = input.ref ? `@${input.ref}` : ""
  if (!input.package_path) return `${input.owner}/${input.repo}${ref}`
  return `https://github.com/${input.owner}/${input.repo}/tree/${input.ref ?? "HEAD"}/${input.package_path}`
}

export async function agentExtensionPolicyOverrides(options: AgentConfigRouteOptions, input: {
  scope: "project" | "machine" | "workspace"
  directory?: string
  workspaceId?: string
  auth?: SignedControlPlaneAuth
}) {
  if (typeof options.agentExtensionPolicyOverrides === "function") {
    return await options.agentExtensionPolicyOverrides(input)
  }
  if (options.agentExtensionPolicyOverrides) return options.agentExtensionPolicyOverrides
  if (
    input.scope === "workspace"
    && input.auth
    && input.workspaceId
    && typeof options.services?.authority?.listAgentExtensionPolicyOverrides === "function"
  ) {
    try {
      return await options.services.authority.listAgentExtensionPolicyOverrides(input.auth, {
        workspaceId: input.workspaceId,
      }) as AgentExtensionPolicyOverride[]
    } catch (err) {
      if (missingAgentExtensionPolicyFunction(err)) return []
      throw err
    }
  }
  return []
}

function missingAgentExtensionPolicyFunction(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes("Could not find public function")
    && message.includes("agentExtensionPolicies:list")
}

export function extensionListBody(
  desired: Awaited<ReturnType<typeof readDesiredExtensionState>>,
  materialized: Awaited<ReturnType<typeof readMaterializedRuntimeRecord>>,
  policyOverrides: AgentExtensionPolicyOverride[],
) {
  return {
    desired,
    materialized,
    effective: Object.fromEntries(desired.installs.map((item) => [
      item.id,
      resolveEffectiveAgentExtensionPolicy(item, policyOverrides),
    ])),
  }
}

export function localExtensionListState(scope: AgentExtensionLifecycleInput) {
  return {
    root: agentExtensionStateRoot(scope),
    desiredPath: installedStatePath(scope),
  }
}

export function captureAgentExtensionMutation(input: {
  services?: ControlPlaneServices
  auth?: SignedControlPlaneAuth
  action: "install" | "update" | "enable" | "disable" | "uninstall"
  scope: "project" | "machine" | "workspace"
  id: string
  workspaceId?: string
  directory?: string
  source?: string
  targets?: readonly string[]
}) {
  try {
    input.services?.telemetry.capture(
      input.auth?.user.subject ?? "local",
      `agent_extension.${input.action}`,
      {
        id: input.id,
        scope: input.scope,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.directory ? { directory: input.directory } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.targets ? { targets: [...input.targets] } : {}),
      },
    )
  } catch {
    // Telemetry is operational evidence, not part of the mutation transaction.
  }
}

export async function localExtensionListBody(scope: AgentExtensionLifecycleInput, policyOverrides: AgentExtensionPolicyOverride[]) {
  const state = localExtensionListState(scope)
  return extensionListBody(
    await readDesiredExtensionState(state.desiredPath),
    await readMaterializedRuntimeRecord(materializedRecordPath(state.root)),
    policyOverrides,
  )
}
