import { importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose"
import { runtimeAccessTokenIssuer } from "@claxedo/workspace-relay"
import { randomToken } from "@claxedo/server-core/platform/auth/web-crypto"
import {
  RUNTIME_ACCESS_TOKEN_ALGORITHM,
  runtimeAccessTokenAlgorithm,
} from "@claxedo/server-core/platform/auth/runtime-access-token"
import {
  isTasksOperation,
  type TasksCapabilityScope,
  type TasksOperation,
} from "@claxedo/server-core/tasks-host/capability"

export const TASKS_CAPABILITY_AUDIENCE = "claxedo-tasks-capability" as const
const DEFAULT_TTL_SECONDS = 30 * 60
const MAX_TTL_SECONDS = 60 * 60

function pem(value: string | undefined) {
  const clean = value?.trim()
  return clean?.replaceAll("\\n", "\n") || undefined
}

/** The deployment lacks what minting or verifying needs — a fault, not a bad credential. */
export class TasksCapabilityConfigurationError extends Error {
  readonly code = "tasks_capability_misconfigured"
}

function required(value: string | undefined, name: string) {
  const clean = value?.trim()
  if (!clean) throw new TasksCapabilityConfigurationError(`Tasks capability requires ${name}`)
  return clean
}

function claims(payload: Record<string, unknown>): TasksCapabilityScope | undefined {
  const read = (name: string) => {
    const value = payload[name]
    return typeof value === "string" && value ? value : undefined
  }
  const userId = read("user_id")
  const orgId = read("org_id")
  const projectId = read("project_id")
  const workspaceId = read("workspace_id")
  if (!userId || !orgId || !projectId || !workspaceId) return undefined
  const granted = payload.operations
  if (!Array.isArray(granted) || granted.length === 0 || !granted.every(isTasksOperation)) return undefined
  const sessionId = read("session_id")
  return {
    userId,
    orgId,
    projectId,
    workspaceId,
    ...(sessionId ? { sessionId } : {}),
    operations: [...new Set<TasksOperation>(granted)],
  }
}

/**
 * The grant a session's agent presents to the control plane's Tasks routes.
 *
 * Signed with the key that signs the Agent Plugins gateway token and bound to
 * its own audience, so neither credential can be replayed as the other. The
 * runtime's own HS256 session credential never leaves the runtime; this is the
 * only thing a sandbox can show the control plane, and it names one workspace,
 * one project, and the operations that workspace's owner allows.
 */
export async function mintTasksCapability(
  scope: TasksCapabilityScope,
  env: Record<string, string | undefined>,
  options: { ttlSeconds?: number; now?: () => number } = {},
) {
  for (const name of ["userId", "orgId", "projectId", "workspaceId"] as const) required(scope[name], name)
  if (scope.sessionId !== undefined) required(scope.sessionId, "sessionId")
  if (scope.operations.length === 0) {
    throw new TasksCapabilityConfigurationError("Tasks capability requires at least one operation")
  }
  const alg = runtimeAccessTokenAlgorithm(env)
  const key = await importPKCS8(required(pem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM), "runtime signing key"), alg)
  const now = Math.floor((options.now?.() ?? Date.now()) / 1_000)
  const requested = Math.floor(options.ttlSeconds ?? DEFAULT_TTL_SECONDS)
  const ttl = Math.min(MAX_TTL_SECONDS, Math.max(60, requested))
  const token = await new SignJWT({
    user_id: scope.userId,
    org_id: scope.orgId,
    project_id: scope.projectId,
    workspace_id: scope.workspaceId,
    ...(scope.sessionId ? { session_id: scope.sessionId } : {}),
    operations: [...scope.operations],
  })
    .setProtectedHeader({ alg })
    .setIssuer(runtimeAccessTokenIssuer)
    .setAudience(TASKS_CAPABILITY_AUDIENCE)
    .setSubject(scope.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .setJti(randomToken())
    .sign(key)
  return { token, expiresAt: (now + ttl) * 1_000 }
}

export async function verifyTasksCapability(
  token: string,
  env: Record<string, string | undefined>,
): Promise<TasksCapabilityScope> {
  const alg = runtimeAccessTokenAlgorithm(env)
  const key = await importSPKI(required(pem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM), "runtime verification key"), alg)
  const result = await jwtVerify(token, key, {
    algorithms: [RUNTIME_ACCESS_TOKEN_ALGORITHM],
    issuer: runtimeAccessTokenIssuer,
    audience: TASKS_CAPABILITY_AUDIENCE,
  })
  const scope = claims(result.payload as Record<string, unknown>)
  if (!scope || result.payload.sub !== scope.userId) throw new Error("Tasks capability scope is invalid")
  return scope
}
