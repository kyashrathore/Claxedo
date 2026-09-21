import { inProcessFetch, type McpClientInputs } from "@claxedo/mcp"
import type { McpCredential } from "@claxedo/mcp/context"
import { BUILTIN_TASKS_TOOL_GROUP } from "@claxedo/server-core/agent-plugins/builtin/plugin"
import { TASKS_OPERATIONS } from "@claxedo/server-core/tasks-host/capability"
import type { TasksSessionGrants } from "@claxedo/server-core/tasks-host/session-grants"

/**
 * How a session on this box presents its Tasks grant: a handle this box issued
 * for the session's own workspace, which the capability branch of the Tasks
 * door resolves to that workspace's owner, its project and the session itself.
 *
 * Both postures present one, because on both the fetch arrives on this
 * process's own loopback, where the routes would otherwise read a session's
 * call as the person at this machine: no project confinement, no agent-start
 * gates, and a link recorded as a person's (security review P105).
 *
 * Only a runtime credential gets one, because only a session has a workspace
 * to be the owner of; an account credential reaches Tasks as itself through
 * the routes it already signs for.
 */
export function selfHostedTasksClientInput(input: {
  app: { request(request: Request): Response | Promise<Response> }
  grants?: TasksSessionGrants
  /**
   * This machine's consented tool groups. Required: the grant exists so the
   * Tasks tools can act, and the switch that hides those tools is the same
   * decision as the one that withholds what they would act with.
   */
  enabledToolGroups: () => readonly string[]
}): (credential: McpCredential) => Promise<McpClientInputs["tasks"]> {
  return async (credential) => {
    if (credential.kind !== "runtime") return undefined
    if (!input.enabledToolGroups().includes(BUILTIN_TASKS_TOOL_GROUP)) return undefined
    const grant = await input.grants?.issue({
      workspaceId: credential.workspaceId,
      ...(credential.sessionId ? { sessionId: credential.sessionId } : {}),
    })
    if (!grant) return undefined
    return {
      fetch: inProcessFetch((call) => input.app.request(call), { authorization: `Bearer ${grant}` }),
      operations: TASKS_OPERATIONS,
    }
  }
}
