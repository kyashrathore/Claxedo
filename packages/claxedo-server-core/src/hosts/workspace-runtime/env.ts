import type { SandboxDriverID } from "@claxedo/sandbox-contract"
import type { TasksOperation } from "@claxedo/server-core/tasks-host/capability"

export const WORKSPACE_RUNTIME_MCP_TOOL_GROUPS = "WORKSPACE_RUNTIME_MCP_TOOL_GROUPS"

/**
 * The first-party tool groups this root's project turned on.
 *
 * A cloud root reads its project's activation once, at launch, and the sandbox
 * cannot ask again: it has no project route of its own. The variable is always
 * written, empty included, so an absent one means an older control plane and a
 * present empty one means a user who turned everything off — a distinction the
 * mount has to make before it decides whether to serve anything at all.
 */
export function workspaceRuntimeMcpToolGroupsEnv(groups: readonly string[]): Record<string, string> {
  return { [WORKSPACE_RUNTIME_MCP_TOOL_GROUPS]: groups.join(",") }
}

export function workspaceRuntimeMcpToolGroups(env: Record<string, string | undefined>): readonly string[] | undefined {
  const declared = env[WORKSPACE_RUNTIME_MCP_TOOL_GROUPS]
  if (declared === undefined) return undefined
  return declared.split(",").map((group) => group.trim()).filter(Boolean)
}

export const WORKSPACE_RUNTIME_TASKS_CAPABILITY = "WORKSPACE_RUNTIME_TASKS_CAPABILITY"
export const WORKSPACE_RUNTIME_TASKS_OPERATIONS = "WORKSPACE_RUNTIME_TASKS_OPERATIONS"
export const WORKSPACE_RUNTIME_TASKS_PROJECT = "WORKSPACE_RUNTIME_TASKS_PROJECT"

/**
 * The Tasks grant a cloud root's sessions act with.
 *
 * Plaintext, unlike the gateway credentials beside it: this is the agent's own
 * scoped grant, presented by tools the agent calls knowingly, so it belongs in
 * the readable environment rather than on the brokered-secret channel, whose
 * whole point is a value the sandbox must never read.
 */
export function workspaceRuntimeTasksCapabilityEnv(input: {
  token: string
  operations: readonly TasksOperation[]
  projectId: string
}): Record<string, string> {
  return {
    [WORKSPACE_RUNTIME_TASKS_CAPABILITY]: input.token,
    [WORKSPACE_RUNTIME_TASKS_OPERATIONS]: input.operations.join(","),
    // The project the grant is confined to. A sandbox has no project route of
    // its own, so a tool that defaults the project reads it here rather than
    // asking the runtime a question only the local server can answer.
    [WORKSPACE_RUNTIME_TASKS_PROJECT]: input.projectId,
  }
}

export const WORKSPACE_RUNTIME_OWNER_GRANT = "WORKSPACE_RUNTIME_OWNER_GRANT"

/**
 * The owner grant a cloud root's runtime presents to act as the workspace's
 * canonical owner: on its own in-process session calls, and to the control
 * plane's session authority behind them.
 *
 * Readable like the Tasks grant: the control plane re-resolves the owner on
 * every use, so a sandbox that reads it holds nothing it could not already
 * ask its own runtime to do.
 */
export function workspaceRuntimeOwnerGrantEnv(input: { token: string }): Record<string, string> {
  return { [WORKSPACE_RUNTIME_OWNER_GRANT]: input.token }
}

export function workspaceRuntimeOwnerGrantToken(env: Record<string, string | undefined>): string | undefined {
  return env[WORKSPACE_RUNTIME_OWNER_GRANT]?.trim() || undefined
}

export function workspaceRuntimeTargetEnv(input: {
  workspaceId: string
  hostId?: string
  directory: string
  port: number
  host?: string
}): Record<string, string> {
  return {
    WORKSPACE_RUNTIME_WORKSPACE_ID: input.workspaceId,
    ...(input.hostId ? { WORKSPACE_RUNTIME_HOST_ID: input.hostId } : {}),
    WORKSPACE_RUNTIME_DIRECTORY: input.directory,
    WORKSPACE_RUNTIME_PORT: String(input.port),
    ...(input.host ? { WORKSPACE_RUNTIME_HOST: input.host } : {}),
  }
}

export function workspaceRuntimeSourceEnv(input: {
  source?: { kind: "git"; repoUrl: string; branch?: string } | { kind: "empty" }
}): Record<string, string> {
  if (!input.source || input.source.kind === "empty") {
    return { WORKSPACE_RUNTIME_SOURCE_KIND: "empty" }
  }
  return {
    WORKSPACE_RUNTIME_SOURCE_KIND: "git",
    WORKSPACE_RUNTIME_GIT_REPO_URL: input.source.repoUrl,
    ...(input.source.branch ? { WORKSPACE_RUNTIME_GIT_BRANCH: input.source.branch } : {}),
  }
}

export function workspaceRuntimeRelayVerificationEnv(input:
  | { kind: "jwks"; jwksUrl: string }
  | { kind: "pem"; verifyPem: string }
  | { kind: "dev-unsafe-private-network" }
): Record<string, string> {
  if (input.kind === "jwks") return { WORKSPACE_RUNTIME_RELAY_JWKS_URL: input.jwksUrl }
  if (input.kind === "pem") return { WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM: input.verifyPem }
  return {
    WORKSPACE_RUNTIME_HOST: "0.0.0.0",
    WORKSPACE_RUNTIME_ALLOW_UNAUTHENTICATED_NON_LOOPBACK: "1",
  }
}

export function workspaceRuntimeConfigTokenEnv(input: { token: string }): Record<string, string> {
  return { WORKSPACE_RUNTIME_CONFIG_TOKEN: input.token }
}

export function workspaceRuntimeServiceExposureEnv(input: {
  driver: SandboxDriverID
  source: "driver-service-url"
  access: "private" | "public" | "driver-authenticated" | "unknown"
  fallbackAccess?: "private" | "public" | "driver-authenticated" | "unknown"
  note?: string
}): Record<string, string> {
  return {
    ...(input.driver === "docker" ? { WORKSPACE_RUNTIME_HOST: "0.0.0.0" } : {}),
    WORKSPACE_RUNTIME_SERVICE_EXPOSURE_SOURCE: input.source,
    WORKSPACE_RUNTIME_SERVICE_EXPOSURE_ACCESS: input.access,
    WORKSPACE_RUNTIME_SERVICE_EXPOSURE_DRIVER: input.driver,
    ...(input.fallbackAccess ? { WORKSPACE_RUNTIME_SERVICE_EXPOSURE_FALLBACK_ACCESS: input.fallbackAccess } : {}),
    ...(input.note ? { WORKSPACE_RUNTIME_SERVICE_EXPOSURE_NOTE: input.note } : {}),
  }
}

/**
 * The lease generation a sandbox process was booted for.
 *
 * Host identity is deliberately absent. `workspaceRuntimeTargetEnv` is its only
 * writer, and what it writes is the hostId the driver also puts on
 * `target.hostId` — the value the lease store persists as `lease_id` and the
 * relay binds and routes on. This env is composed after the driver's, so
 * anything restated here wins: a caller holding a provider resource id rather
 * than the hostId would unbind the host from the relay without failing.
 */
export function sandboxLeaseEnv(input: { leaseId: string; epoch: number }): Record<string, string> {
  return {
    WORKSPACE_RUNTIME_LEASE_ID: input.leaseId,
    WORKSPACE_RUNTIME_EPOCH: String(input.epoch),
  }
}
