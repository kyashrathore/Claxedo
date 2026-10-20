import type { TasksOperation } from "./capability"

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
