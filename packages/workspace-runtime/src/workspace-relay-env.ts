import { workspaceId } from "./target"
import {
  loadRelayHostVerificationKeyOrJwks,
  type RelayHostAuthOptions,
} from "./workspace-host-service-auth"
import type { WorkspaceRelayHostTunnelOptions } from "./workspace-relay-host-tunnel"
import {
  createWorkspaceRuntimeJwtManagementAuth,
  loadWorkspaceRuntimeManagementVerificationKey,
  type WorkspaceRuntimeManagementAuth,
  type WorkspaceRuntimeManagementTarget,
} from "./management-auth"

export type WorkspaceRelayRuntimeOptions = {
  relayHostAuth?: RelayHostAuthOptions
  hostTunnel?: WorkspaceRelayHostTunnelOptions
  configToken?: string
  managementAuth?: WorkspaceRuntimeManagementAuth
  managementTarget?: WorkspaceRuntimeManagementTarget
}

type Env = NodeJS.ProcessEnv

function text(env: Env, key: string) {
  const value = env[key]?.trim()
  return value || undefined
}

function numberEnv(env: Env, key: string) {
  const value = text(env, key)
  if (!value) return
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  throw new Error(`${key} must be a positive number`)
}

function listEnv(env: Env, key: string) {
  return text(env, key)
    ?.split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function normalized(input: string) {
  return input.replace(/\/+$/, "")
}

function authHeaders(env: Env) {
  const raw = text(env, "WORKSPACE_RUNTIME_RELAY_TUNNEL_AUTHORIZATION")
  if (raw) return { authorization: raw }
  const token = text(env, "WORKSPACE_RUNTIME_RELAY_TUNNEL_TOKEN")
  return token ? { authorization: `Bearer ${token}` } : undefined
}

export async function relayHostAuthFromEnv(env: Env = process.env): Promise<RelayHostAuthOptions | undefined> {
  const hostId = text(env, "WORKSPACE_RUNTIME_HOST_ID") ?? workspaceId(env)
  const trustedDirectToken = text(env, "WORKSPACE_RUNTIME_TRUSTED_DIRECT_TOKEN")
  const jwksUrl = text(env, "WORKSPACE_RUNTIME_RELAY_JWKS_URL")
  const verifyPem = text(env, "WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM")
  if (jwksUrl || verifyPem) {
    return {
      key: await loadRelayHostVerificationKeyOrJwks({
        WORKSPACE_RUNTIME_RELAY_JWKS_URL: jwksUrl,
        WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM: verifyPem,
      }),
      workspaceId: workspaceId(env),
      hostId,
      trustedDirectToken,
    }
  }
}

export function hostTunnelFromEnv(env: Env = process.env, port = 3002): WorkspaceRelayHostTunnelOptions | undefined {
  const relayUrl = text(env, "WORKSPACE_RUNTIME_RELAY_URL")
  if (!relayUrl) return
  const hostId = text(env, "WORKSPACE_RUNTIME_HOST_ID") ?? workspaceId(env)
  return {
    relayUrl: normalized(relayUrl),
    hostId,
    workspaceIds: listEnv(env, "WORKSPACE_RUNTIME_RELAY_WORKSPACE_IDS") ?? [workspaceId(env)],
    localBaseUrl: text(env, "WORKSPACE_RUNTIME_LOCAL_BASE_URL") ?? `http://127.0.0.1:${port}`,
    headers: authHeaders(env),
    pingIntervalMs: numberEnv(env, "WORKSPACE_RUNTIME_RELAY_PING_INTERVAL_MS"),
  }
}

export function configTokenFromEnv(env: Env = process.env) {
  return text(env, "WORKSPACE_RUNTIME_CONFIG_TOKEN")
    ?? text(env, "WORKSPACE_RUNTIME_TRUSTED_DIRECT_TOKEN")
}

export async function managementAuthFromEnv(env: Env = process.env): Promise<WorkspaceRuntimeManagementAuth | undefined> {
  const jwksUrl = text(env, "WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL")
  const verifyPem = text(env, "WORKSPACE_RUNTIME_MANAGEMENT_VERIFY_PEM")
  const issuer = text(env, "WORKSPACE_RUNTIME_MANAGEMENT_ISSUER")
  const audience = text(env, "WORKSPACE_RUNTIME_MANAGEMENT_AUDIENCE")
  if (!issuer || !audience) return
  if (!jwksUrl && !verifyPem) return
  return createWorkspaceRuntimeJwtManagementAuth({
    key: await loadWorkspaceRuntimeManagementVerificationKey({
      WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL: jwksUrl,
      WORKSPACE_RUNTIME_MANAGEMENT_VERIFY_PEM: verifyPem,
    }),
    issuer,
    audience,
  })
}

export function managementTargetFromEnv(env: Env = process.env): WorkspaceRuntimeManagementTarget {
  const id = workspaceId(env)
  return {
    workspaceId: id,
    hostId: text(env, "WORKSPACE_RUNTIME_HOST_ID") ?? id,
  }
}

export async function workspaceRelayRuntimeOptionsFromEnv(
  env: Env = process.env,
  port = 3002,
): Promise<WorkspaceRelayRuntimeOptions> {
  const managementAuth = await managementAuthFromEnv(env)
  return {
    relayHostAuth: await relayHostAuthFromEnv(env),
    hostTunnel: hostTunnelFromEnv(env, port),
    configToken: configTokenFromEnv(env),
    ...(managementAuth ? { managementAuth, managementTarget: managementTargetFromEnv(env) } : {}),
  }
}
