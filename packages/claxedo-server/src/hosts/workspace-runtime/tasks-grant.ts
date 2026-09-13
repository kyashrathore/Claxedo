import { WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL } from "@claxedo/workspace-runtime"
import { isTasksOperation, type TasksOperation } from "@claxedo/server-core/tasks-host/capability"
import {
  WORKSPACE_RUNTIME_TASKS_CAPABILITY,
  WORKSPACE_RUNTIME_TASKS_OPERATIONS,
  WORKSPACE_RUNTIME_TASKS_PROJECT,
} from "@claxedo/server-core/hosts/workspace-runtime/env"
import type { TasksGrant } from "@claxedo/mcp"

/**
 * Where this runtime reaches its control plane.
 *
 * Derived from the session-authority endpoint the host is already booted with,
 * because that is the one channel a sandboxed runtime has to the plane: a
 * second URL would be a second thing to configure, a second thing to get
 * wrong, and a second egress destination to allow.
 */
export function controlPlaneOrigin(env: NodeJS.ProcessEnv): string | undefined {
  const authority = env[WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL]?.trim()
  if (!authority) return undefined
  try {
    return new URL(authority).origin
  } catch {
    return undefined
  }
}

function grantedOperations(value: string | undefined): readonly TasksOperation[] {
  return [...new Set((value ?? "").split(",").map((name) => name.trim()).filter(isTasksOperation))]
}

/**
 * The Tasks grant this runtime was launched with, as the MCP client takes it.
 *
 * Absent whenever the control plane minted none, could not be located, or
 * granted nothing — and then the first-party MCP mount carries no Tasks
 * client, which is how a deployment without Tasks answers the tools.
 */
export function workspaceRuntimeTasksGrant(env: NodeJS.ProcessEnv = process.env): TasksGrant | undefined {
  const token = env[WORKSPACE_RUNTIME_TASKS_CAPABILITY]?.trim()
  const granted = grantedOperations(env[WORKSPACE_RUNTIME_TASKS_OPERATIONS])
  const projectId = env[WORKSPACE_RUNTIME_TASKS_PROJECT]?.trim()
  const origin = controlPlaneOrigin(env)
  if (!token || !origin || granted.length === 0) return undefined
  return {
    operations: granted,
    ...(projectId ? { projectId } : {}),
    fetch: async (path, init) => {
      const request = new Request(new URL(path, origin), init)
      request.headers.set("authorization", `Bearer ${token}`)
      return await fetch(request)
    },
  }
}
