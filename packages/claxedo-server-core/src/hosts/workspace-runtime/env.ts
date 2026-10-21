import type { SandboxDriverID } from "@claxedo/sandbox-contract"

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

export const WORKSPACE_RUNTIME_PROJECT_ENV_NAMES = "WORKSPACE_RUNTIME_PROJECT_ENV_NAMES"

/**
 * A project's own variables, as the sandbox receives them beside everything
 * else in its process environment. The names ride along because the runtime
 * cannot otherwise tell a project's `DATABASE_URL` from the control plane's
 * grants and tokens in the same environment, and only the former may reach
 * the repository's `.claxedo` scripts.
 */
export function workspaceRuntimeProjectEnv(values: Record<string, string>): Record<string, string> {
  return { ...values, [WORKSPACE_RUNTIME_PROJECT_ENV_NAMES]: Object.keys(values).sort().join(",") }
}

export function workspaceRuntimeProjectEnvValues(env: Record<string, string | undefined>): Record<string, string> {
  const values: Record<string, string> = {}
  for (const name of env[WORKSPACE_RUNTIME_PROJECT_ENV_NAMES]?.split(",") ?? []) {
    const value = env[name]
    if (name && value !== undefined) values[name] = value
  }
  return values
}

export const WORKSPACE_RUNTIME_OWNER_GRANT = "WORKSPACE_RUNTIME_OWNER_GRANT"

/**
 * The owner grant a cloud root's runtime presents to act as the workspace's
 * canonical owner: on its own in-process session calls, and to the control
 * plane's session authority behind them.
 *
 * Readable like a plugin's grant: the control plane re-resolves the owner on
 * every use, so a sandbox that reads it holds nothing it could not already
 * ask its own runtime to do.
 */
export function workspaceRuntimeOwnerGrantEnv(input: { token: string }): Record<string, string> {
  return { [WORKSPACE_RUNTIME_OWNER_GRANT]: input.token }
}

export function workspaceRuntimeOwnerGrantToken(env: Record<string, string | undefined>): string | undefined {
  return env[WORKSPACE_RUNTIME_OWNER_GRANT]?.trim() || undefined
}

export const WORKSPACE_RUNTIME_PLUGIN_TOOLS_GRANT = "WORKSPACE_RUNTIME_PLUGIN_TOOLS_GRANT"

/**
 * The grant a cloud root's first-party MCP presents to the control plane for
 * its app plugins' tools. The runtime holds it, not the agent: the name is
 * outside the harness allowlist, so no session's child process reads it.
 */
export function workspaceRuntimePluginToolsGrantEnv(input: { token: string }): Record<string, string> {
  return { [WORKSPACE_RUNTIME_PLUGIN_TOOLS_GRANT]: input.token }
}

export function workspaceRuntimePluginToolsGrantToken(env: Record<string, string | undefined>): string | undefined {
  return env[WORKSPACE_RUNTIME_PLUGIN_TOOLS_GRANT]?.trim() || undefined
}

/** Where a cloud runtime takes, and answers about, the pass it publishes its sessions' list rows with. */
export const SESSION_ROWS_PASS_PATH = "/api/claxedo/session-rows/pass"

/** Where the control plane takes, once, the start phases a cloud runtime timed while it booted. */
export const RUNTIME_START_PHASES_PATH = "/api/claxedo/start-phases"

/** Where the control plane hands a serving runtime its lease env afresh, before the placeholders its boot was given expire. */
export const RUNTIME_LEASE_ENV_PATH = "/api/claxedo/lease-env"

/** The pass a runtime holds, as its claims read without verifying; null before the control plane delivered one. */
export type SessionRowsPassHeld = { epoch: number; issuedAt: number; expiresAt: number } | null

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

export function workspaceRuntimeConfigTokenEnv(input: { token: string }): Record<string, string> {
  return { WORKSPACE_RUNTIME_CONFIG_TOKEN: input.token }
}

export function workspaceRuntimeServiceExposureEnv(input: {
  driver: SandboxDriverID
  source: "driver-service-url"
  access: "private" | "public" | "driver-authenticated" | "unknown"
  note?: string
}): Record<string, string> {
  return {
    ...(input.driver === "docker" ? { WORKSPACE_RUNTIME_HOST: "0.0.0.0" } : {}),
    WORKSPACE_RUNTIME_SERVICE_EXPOSURE_SOURCE: input.source,
    WORKSPACE_RUNTIME_SERVICE_EXPOSURE_ACCESS: input.access,
    WORKSPACE_RUNTIME_SERVICE_EXPOSURE_DRIVER: input.driver,
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
