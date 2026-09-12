import { tasksErrorDetail, type TasksSessionBridgePort } from "@claxedo/tasks"
import type { WorkspaceRuntimeClientOptions } from "@claxedo/server-core/workspace/http/workspace-runtime-client"
import type { ControlPlaneServices } from "../authority/services"

export type HostedTasksSessionBridgeInput = {
  services: ControlPlaneServices
  runtimeClient: WorkspaceRuntimeClientOptions
}

/**
 * Tasks' half of Start on a hosted control plane: the managed session
 * reservation, then the workspace runtime the control plane dispatches to.
 * Every answer is read at call time from that runtime and from the projection
 * store; nothing about a session's liveness is kept here.
 */
export function createHostedTasksSessionBridge(_input: HostedTasksSessionBridgeInput): TasksSessionBridgePort {
  return {
    async sessionState(sessions) {
      return sessions.map((session) => ({ session, state: "unavailable" as const }))
    },
    async preview() {
      return { ok: false, error: tasksErrorDetail("unsupported", "Hosted Start is not implemented yet") }
    },
    async start() {
      return { ok: false, error: tasksErrorDetail("unsupported", "Hosted Start is not implemented yet") }
    },
  }
}
