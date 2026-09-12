import { tasksErrorDetail, type TasksSessionBridgePort } from "@claxedo/tasks"

/**
 * Tasks' half of Start on a local host: the embedded workspace runtime this
 * process already serves. Every answer is read at call time from that runtime
 * and from the projection store; nothing about a session's liveness is kept
 * here.
 */
export function createLocalTasksSessionBridge(): TasksSessionBridgePort {
  return {
    async sessionState(sessions) {
      return sessions.map((session) => ({ session, state: "unavailable" as const }))
    },
    async preview() {
      return { ok: false, error: tasksErrorDetail("unsupported", "Local Start is not implemented yet") }
    },
    async start() {
      return { ok: false, error: tasksErrorDetail("unsupported", "Local Start is not implemented yet") }
    },
  }
}
