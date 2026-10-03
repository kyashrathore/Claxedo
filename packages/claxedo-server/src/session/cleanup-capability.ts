import { decodeJwt } from "jose"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { workspaceRuntimeSessionCleanupGrantEnv } from "@claxedo/server-core/hosts/workspace-runtime/env"
import { credentialFault } from "../platform/auth/runtime-token-keys"
import { mintSandboxPass, verifySandboxPass } from "../platform/auth/sandbox-pass"
import type { SandboxPassRegister } from "../platform/auth/sandbox-pass-register"
import type { CloudRootIdentity } from "../agent-plugins/runtime/cloud-root-environment"
import { AGENT_PLUGIN_ALL_PROJECTS_SCOPE, AGENT_PLUGIN_DESKTOP_WORKSPACE } from "@claxedo/server-core/agent-plugins/activation/runtime-scope"

export const SESSION_CLEANUP_AUDIENCE = "claxedo-session-cleanup" as const
export const SESSION_CLEANUP_OPERATIONS = ["read", "delete"] as const

export type SessionCleanupScope = CloudRootIdentity & Readonly<{
  actorId: string
  sessionId?: string
  host?: { hostId: string; enrollmentId: string; generation: number }
  desktop?: true
}>

export class SessionCleanupConfigurationError extends Error {
  readonly code = "session_cleanup_misconfigured"
}

const fault = credentialFault("Session cleanup capability", SessionCleanupConfigurationError)

export async function mintSessionCleanupCapability(
  scope: SessionCleanupScope,
  env: Record<string, string | undefined>,
  options: { register?: SandboxPassRegister; ttlSeconds?: number; now?: () => number } = {},
) {
  const { actorId, host, desktop, ...identity } = scope
  const extra = { actor_id: actorId, ...(host ? { host_id: host.hostId, enrollment_id: host.enrollmentId, host_generation: String(host.generation) } : {}), ...(desktop ? { desktop_owner: "true" } : {}) }
  return mintSandboxPass({ audience: SESSION_CLEANUP_AUDIENCE, scope: identity, operations: SESSION_CLEANUP_OPERATIONS, extra, ...options }, env, fault)
}

export function isSessionCleanupCapability(token: string): boolean {
  try {
    return decodeJwt(token).aud === SESSION_CLEANUP_AUDIENCE
  } catch {
    return false
  }
}

export async function verifySessionCleanupCapability(
  token: string,
  env: Record<string, string | undefined>,
  options: { revoked?: (jti: string) => Promise<boolean>; now?: () => number } = {},
): Promise<SessionCleanupScope> {
  const pass = await verifySandboxPass(token, env, { audience: SESSION_CLEANUP_AUDIENCE, fault, ...options })
  const actorId = pass.extra.actor_id
  const { userId, orgId, workspaceId, projectId } = pass.scope
  const host = cleanupHost(pass.extra)
  const desktop = pass.extra.desktop_owner === "true"
  if (!projectId || typeof actorId !== "string" || !actorId
    || pass.operations.length !== SESSION_CLEANUP_OPERATIONS.length
    || !SESSION_CLEANUP_OPERATIONS.every((operation) => pass.operations.includes(operation))) {
    throw new Error("Session cleanup capability scope is invalid")
  }
  if (host && !pass.scope.sessionId && (workspaceId !== AGENT_PLUGIN_DESKTOP_WORKSPACE || projectId !== AGENT_PLUGIN_ALL_PROJECTS_SCOPE)) throw new Error("A project cleanup capability requires its originating session")
  if (pass.extra.desktop_owner !== undefined && (!desktop || host || pass.scope.sessionId || workspaceId !== AGENT_PLUGIN_DESKTOP_WORKSPACE || projectId !== AGENT_PLUGIN_ALL_PROJECTS_SCOPE)) throw new Error("Invalid desktop cleanup binding")
  return { userId, actorId, orgId, workspaceId, projectId, ...(pass.scope.sessionId ? { sessionId: pass.scope.sessionId } : {}), ...(host ? { host } : {}), ...(desktop ? { desktop: true as const } : {}) }
}

function cleanupHost(extra: Readonly<Record<string, unknown>>) {
  if (extra.host_id === undefined && extra.enrollment_id === undefined && extra.host_generation === undefined) return undefined
  const generation = Number(extra.host_generation)
  if (typeof extra.host_id !== "string" || !extra.host_id || typeof extra.enrollment_id !== "string" || !extra.enrollment_id
    || typeof extra.host_generation !== "string" || !Number.isSafeInteger(generation) || generation < 0) throw new Error("Invalid machine cleanup binding")
  return { hostId: extra.host_id, enrollmentId: extra.enrollment_id, generation }
}

export type SessionCleanupCapabilityInput = Readonly<{
  signingEnv: Record<string, string | undefined>
  passes?: SandboxPassRegister
  workspaceOwner: NonNullable<WorkspaceAuthority["resolveWorkspaceOwner"]>
  enabled: (root: CloudRootIdentity) => Promise<boolean>
  ttlSeconds?: number
  now?: () => number
  originAllowed?: (scope: SessionCleanupScope) => Promise<boolean>
  originParentMatches?: (scope: SessionCleanupScope, parentSessionId: string | undefined) => Promise<boolean>
  machineOwner?: (scope: SessionCleanupScope) => Promise<{ userId: string; actorId: string; orgId: string; projectId: string } | undefined>
  desktopOwner?: (scope: SessionCleanupScope) => Promise<{ userId: string; actorId: string; orgId: string; projectId: string } | undefined>
}>

export async function resolveSessionCleanupOwner(input: SessionCleanupCapabilityInput, scope: SessionCleanupScope) {
  const owner = isDesktopSessionCleanupScope(scope)
    ? await input.desktopOwner?.(scope)
    : isMachineSessionCleanupScope(scope) ? await input.machineOwner?.(scope) : await input.workspaceOwner(scope.workspaceId)
  if (!owner || owner.userId !== scope.userId || owner.actorId !== scope.actorId
    || owner.orgId !== scope.orgId || owner.projectId !== scope.projectId) return undefined
  if (!(await input.enabled(scope))) return undefined
  if (scope.sessionId && (!input.originAllowed || !(await input.originAllowed(scope)))) return undefined
  return owner
}

export function isMachineSessionCleanupScope(scope: SessionCleanupScope) {
  return scope.host !== undefined && scope.sessionId === undefined && scope.workspaceId === AGENT_PLUGIN_DESKTOP_WORKSPACE && scope.projectId === AGENT_PLUGIN_ALL_PROJECTS_SCOPE
}

export function isDesktopSessionCleanupScope(scope: SessionCleanupScope) {
  return scope.desktop === true && scope.host === undefined && scope.sessionId === undefined && scope.workspaceId === AGENT_PLUGIN_DESKTOP_WORKSPACE && scope.projectId === AGENT_PLUGIN_ALL_PROJECTS_SCOPE
}

export function createSessionCleanupRootGrant(input: SessionCleanupCapabilityInput) {
  return async (root: CloudRootIdentity) => {
    const owner = await input.workspaceOwner(root.workspaceId)
    if (!owner || owner.userId !== root.userId || owner.orgId !== root.orgId || owner.projectId !== root.projectId
      || !(await input.enabled(root))) throw new Error("This workspace cannot issue session cleanup capabilities")
    return mintSessionCleanupCapability({ ...root, actorId: owner.actorId }, input.signingEnv, {
      ...(input.passes ? { register: input.passes } : {}),
      ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
      ...(input.now ? { now: input.now } : {}),
    })
  }
}

export function createSessionCleanupRootEnvironment(input: SessionCleanupCapabilityInput) {
  const grant = createSessionCleanupRootGrant(input)
  return async (root: CloudRootIdentity): Promise<Record<string, string>> =>
    workspaceRuntimeSessionCleanupGrantEnv({ token: (await grant(root)).token })
}
