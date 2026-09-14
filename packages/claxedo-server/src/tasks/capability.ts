import { mintSandboxPass, verifySandboxPass } from "../platform/auth/sandbox-pass"
import type { SandboxPassRegister } from "../platform/auth/sandbox-pass-register"
import {
  isTasksOperation,
  type TasksCapabilityScope,
  type TasksOperation,
} from "@claxedo/server-core/tasks-host/capability"

export const TASKS_CAPABILITY_AUDIENCE = "claxedo-tasks-capability" as const

/** The deployment lacks what minting or verifying needs — a fault, not a bad credential. */
export class TasksCapabilityConfigurationError extends Error {
  readonly code = "tasks_capability_misconfigured"
}

const unsignable = (name: string) => new TasksCapabilityConfigurationError(`Tasks capability requires ${name}`)

/**
 * The grant a session's agent presents to the control plane's Tasks routes:
 * a sandbox pass under its own audience whose operations are the Tasks
 * vocabulary and whose scope always names the project.
 */
export async function mintTasksCapability(
  scope: TasksCapabilityScope,
  env: Record<string, string | undefined>,
  options: { ttlSeconds?: number; now?: () => number; register?: SandboxPassRegister } = {},
) {
  const { operations, ...identity } = scope
  return await mintSandboxPass({ audience: TASKS_CAPABILITY_AUDIENCE, scope: identity, operations, ...options }, env, unsignable)
}

export async function verifyTasksCapability(
  token: string,
  env: Record<string, string | undefined>,
  options: { revoked?: (jti: string) => Promise<boolean> } = {},
): Promise<TasksCapabilityScope> {
  const pass = await verifySandboxPass(token, env, { audience: TASKS_CAPABILITY_AUDIENCE, fault: unsignable, ...options })
  const { userId, orgId, projectId, workspaceId, sessionId } = pass.scope
  if (!projectId || pass.operations.length === 0 || !pass.operations.every(isTasksOperation)) {
    throw new Error("Tasks capability scope is invalid")
  }
  return {
    userId,
    orgId,
    projectId,
    workspaceId,
    ...(sessionId ? { sessionId } : {}),
    operations: [...new Set<TasksOperation>(pass.operations)],
  }
}
