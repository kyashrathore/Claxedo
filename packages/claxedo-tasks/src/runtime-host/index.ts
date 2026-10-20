import type { McpServiceGrant } from "@claxedo/mcp/tool-group"
import type { RuntimeHostPlugin } from "@claxedo/server-core/plugins/runtime-host"
import { TASKS_MCP_TOOL_GROUP } from "../mcp"
import { workspaceRuntimeTasksGrant } from "./tasks-grant"

export {
  workspaceRuntimeTasksGrant,
  type TasksGrantState,
  type WorkspaceRuntimeTasksGrant,
  type WorkspaceRuntimeTasksGrantOptions,
} from "./tasks-grant"

/**
 * Tasks in a cloud root's runtime: its tool group, and the capability the
 * control plane launched the root with, kept renewed while the runtime runs.
 * A root launched with no capability serves the tools to no Tasks service.
 */
export const tasksRuntimeHostPlugin: RuntimeHostPlugin = {
  id: "claxedo-tasks",
  mcp: { groups: [TASKS_MCP_TOOL_GROUP] },
  start(env, input) {
    const grant = workspaceRuntimeTasksGrant(env, input.ownerGrant ? { ownerGrant: input.ownerGrant } : {})
    if (!grant) return undefined
    grant.start()
    return {
      mcpServices: (): Readonly<Record<string, McpServiceGrant>> => {
        const current = grant.current()
        return current ? { tasks: current } : {}
      },
      dispose: grant.stop,
    }
  },
}
