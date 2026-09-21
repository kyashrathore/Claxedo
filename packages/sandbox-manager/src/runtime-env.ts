import type { SandboxDriverID } from "@claxedo/sandbox-contract"

export type WorkspaceRuntimeControlEnv = {
  relayJwksUrl?: string
  relayVerifyPem?: string
  managementJwksUrl?: string
  sessionAuthorityUrl?: string
}

/**
 * The env keys that decide who a booted runtime IS: the workspace it serves,
 * the hostId it registers under — the same value the driver returns as
 * `target.hostId` and the lease store persists — and the workspace set a
 * host tunnel may claim. Each is written only from structured input below;
 * a caller env restating one would boot a runtime bound to an identity the
 * lease never authorized, so the composition refuses the key outright
 * rather than let whichever spread lands last decide silently.
 */
const WORKSPACE_RUNTIME_IDENTITY_ENV_KEYS = [
  "WORKSPACE_RUNTIME_WORKSPACE_ID",
  "WORKSPACE_RUNTIME_HOST_ID",
  "WORKSPACE_RUNTIME_RELAY_WORKSPACE_IDS",
] as const

export function workspaceRuntimeIdentityEnvConflicts(env: Record<string, string> | undefined): string[] {
  if (!env) return []
  return WORKSPACE_RUNTIME_IDENTITY_ENV_KEYS.filter((key) => env[key] !== undefined)
}

export function assertWorkspaceRuntimeIdentityEnv(env: Record<string, string> | undefined) {
  const conflicts = workspaceRuntimeIdentityEnvConflicts(env)
  if (conflicts.length === 0) return
  throw new Error(
    `sandbox env cannot set runtime identity ${conflicts.join(", ")}: `
    + "the driver's placement owns the identity its target reports and the lease records",
  )
}

export function workspaceRuntimeBootEnv(input: Parameters<typeof workspaceRuntimeTargetEnv>[0] &
  Parameters<typeof workspaceRuntimeSourceEnv>[0] & {
    env?: Record<string, string>
    runner?: string
    controlEnv?: WorkspaceRuntimeControlEnv
  }): Record<string, string> {
  assertWorkspaceRuntimeIdentityEnv(input.env)
  const env = {
    ...workspaceRuntimeTargetEnv(input),
    ...workspaceRuntimeSourceEnv(input),
    ...input.env,
  }
  if (input.runner) env.WORKSPACE_RUNTIME_RUNNER = input.runner
  if (input.controlEnv?.relayJwksUrl) env.WORKSPACE_RUNTIME_RELAY_JWKS_URL = input.controlEnv.relayJwksUrl
  if (input.controlEnv?.relayVerifyPem) env.WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM = input.controlEnv.relayVerifyPem
  if (input.controlEnv?.managementJwksUrl) env.WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL = input.controlEnv.managementJwksUrl
  if (input.controlEnv?.sessionAuthorityUrl) env.WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL = input.controlEnv.sessionAuthorityUrl
  return env
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
  if (!input.source || input.source.kind === "empty") return { WORKSPACE_RUNTIME_SOURCE_KIND: "empty" }
  return {
    WORKSPACE_RUNTIME_SOURCE_KIND: "git",
    WORKSPACE_RUNTIME_GIT_REPO_URL: input.source.repoUrl,
    ...(input.source.branch ? { WORKSPACE_RUNTIME_GIT_BRANCH: input.source.branch } : {}),
  }
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
