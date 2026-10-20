import type { LocalServerPlugin } from "@claxedo/server-core/plugins/server-plugin"
import { TASKS_MCP_TOOL_GROUP } from "../mcp"
import {
  capabilityTasksAuthenticate,
  confineCapabilityBridge,
  createLocalTasksAuthorization,
  createTasksPrincipals,
  localTasksWorkspaceOwner,
  unsignedLocalTasksAuthenticate,
} from "../host/authorization"
import { gateAgentStarts } from "../host/agent-start-gates"
import { TASKS_OPERATIONS } from "../host/capability"
import { tasksRouteContribution } from "../host/contribution"
import { createTasksCapabilities } from "../host/host-ports"
import { createTasksSessionGrants } from "../host/session-grants"
import { sqliteTasksStore } from "../storage/sqlite/sqlite-store"
import { TASKS_SQLITE_SCHEMA } from "../storage/sqlite/schema"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { createLocalTasksSessionBridge } from "./session-bridge"

export type LocalTasksPluginInput = {
  /**
   * The tool groups this machine has turned on, read at every issue and every
   * verify. The switch that hides the Tasks tools is the same decision as the
   * one that withdraws the handle they would act with, so a grant a session
   * is still holding stops answering the moment Tasks is turned off. Absent
   * means Tasks is always on.
   */
  enabledGroups?: () => readonly string[]
}

/**
 * Enabled desktop-local Tasks. Only a product entry that composes this plugin
 * gets the feature: the routes, the SQLite tables and the kit itself stay out
 * of a build that does not, exactly as Agent Plugins does.
 *
 * Two callers reach these routes and they are not the same caller. The person
 * at this machine arrives over loopback with no grant, and the scope is the
 * machine and the owner is that one person. A model inside a session arrives
 * with the handle its MCP service grant carries, and is held to the workspace
 * that session runs in, the project that workspace sits in, and the
 * agent-start gates — the same capability path a hosted root's grant takes.
 * The registry that issues the handle and the routes that verify it are one
 * value here, so a host cannot mount one without the other.
 *
 * Presets are still filtered by owner, because the same pair is an
 * organization and one of its members on a hosted deployment and the kit's
 * rules must not differ between the two.
 */
export function createLocalTasksPlugin(input: LocalTasksPluginInput = {}): LocalServerPlugin {
  const principals = createTasksPrincipals()
  const { enabledGroups } = input
  const grants = createTasksSessionGrants({
    workspaceOwner: async (workspaceId) => {
      const workspace = await resolveWorkspace({ workspaceId })
      return workspace ? localTasksWorkspaceOwner(workspace.project_id ?? workspace.id) : undefined
    },
    ...(enabledGroups ? { enabled: () => enabledGroups().includes(TASKS_MCP_TOOL_GROUP.id) } : {}),
  })
  const { capability } = grants
  const routeContributions = [
    tasksRouteContribution({
      store: sqliteTasksStore,
      authorization: createLocalTasksAuthorization(principals, capability),
      authenticate: capabilityTasksAuthenticate({
        capability,
        principals,
        signed: unsignedLocalTasksAuthenticate(principals),
      }),
      bridge: confineCapabilityBridge(
        principals,
        capability,
        gateAgentStarts(principals, capability, sqliteTasksStore, createLocalTasksSessionBridge()),
      ),
      // This machine runs the sessions it starts and has no cloud root to
      // isolate: a cloud preset is refused when it is saved rather than saved
      // and refused at Start.
      capabilities: createTasksCapabilities({ placements: ["local"], cloudSelectedCapabilities: false }),
    }),
  ]
  return {
    id: "claxedo-tasks",
    capability: "tasks",
    sqliteSchema: TASKS_SQLITE_SCHEMA,
    routeContributions: () => routeContributions,
    mcp: {
      groups: [TASKS_MCP_TOOL_GROUP],
      service: {
        id: "tasks",
        // A session whose Tasks group is off, or whose workspace names no
        // owner, keeps the bare loopback fetch that reads as the person at
        // this machine.
        async grant({ workspaceId, sessionId, enabledGroups, inProcessFetch }) {
          if (!workspaceId) return undefined
          const handle = enabledGroups.includes(TASKS_MCP_TOOL_GROUP.id)
            ? await grants.issue({ workspaceId, ...(sessionId ? { sessionId } : {}) })
            : undefined
          return {
            fetch: inProcessFetch(handle ? { authorization: `Bearer ${handle}` } : { "x-workspace-id": workspaceId }),
            operations: TASKS_OPERATIONS,
          }
        },
      },
    },
  }
}
