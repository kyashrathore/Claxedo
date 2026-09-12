import type { PrivateSessionAuthority, PrivateSessionRuntimePrincipal } from "@claxedo/server-core/platform/auth/private-session-authority"
import { CONTROL_PLANE_RUNTIME_ACTOR } from "@claxedo/server-core/platform/auth/runtime-actor"
import {
  createTasksSessionBridge,
  type TasksSessionReservation,
} from "@claxedo/server-core/tasks-host/session-bridge-core"
import {
  createWorkspaceRuntimeClient,
  type WorkspaceRuntimeClientOptions,
} from "@claxedo/server-core/workspace/http/workspace-runtime-client"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { tasksErrorDetail, type TasksActor, type TasksSessionBridgePort } from "@claxedo/tasks"
import { isComposedAuthorityPort } from "../authority/composed-authority"
import type { ControlPlaneServices } from "../authority/services"

export type HostedTasksSessionBridgeInput = {
  services: ControlPlaneServices
  runtimeClient: WorkspaceRuntimeClientOptions
  /**
   * The runtime principal a Start acts as. Without one the control plane's own
   * service actor reserves the session, which is the composition's decision to
   * make: the bridge port carries a Tasks actor, and a Tasks actor's owner id
   * is a provider subject, never a canonical actor id.
   */
  principal?: (actor: TasksActor) => Promise<PrivateSessionRuntimePrincipal | undefined>
}

/**
 * Tasks' half of Start on a hosted control plane: the managed session
 * reservation this host requires before a create, then the workspace runtime
 * the control plane dispatches to.
 */
export function createHostedTasksSessionBridge(input: HostedTasksSessionBridgeInput): TasksSessionBridgePort {
  return createTasksSessionBridge({
    async target(workspaceId) {
      const workspace = await resolveWorkspace({ workspaceId }).catch(() => undefined)
      if (!workspace) return null
      try {
        const client = createWorkspaceRuntimeClient({ workspace, options: input.runtimeClient })
        return { workspace, request: (path, init) => client.request(path, init) }
      } catch {
        // A workspace this composition cannot dispatch to — no sandbox manager,
        // no relay, no local runtime in a Worker — is unreachable, not a fault.
        return null
      }
    },

    sessionMetas: (sessionIds) => input.services.projectionStore.session_metas([...sessionIds]),

    async reserve(intent): Promise<TasksSessionReservation> {
      const authority = input.services.authority ?? undefined
      if (!isComposedAuthorityPort<Pick<PrivateSessionAuthority, "reserveRuntimeSession">>(
        authority,
        ["reserveRuntimeSession"],
      )) {
        return { ok: false, error: tasksErrorDetail("unsupported", "Session registration is unavailable on this host") }
      }
      const reservation = await authority.reserveRuntimeSession(CONTROL_PLANE_RUNTIME_ACTOR, {
        operationId: intent.origin,
        sessionId: intent.sessionId,
        workspaceId: intent.workspaceId,
        kind: "create",
        title: intent.title,
      })
      if (reservation.sessionId !== intent.sessionId || reservation.operationId !== intent.origin) {
        return {
          ok: false,
          error: tasksErrorDetail("conflict", `Origin ${intent.origin} is reserved for another session`),
        }
      }
      if (reservation.state === "compensation_pending" || reservation.state === "compensated") {
        return {
          ok: false,
          error: tasksErrorDetail("conflict", `Origin ${intent.origin} was compensated and can no longer register a session`),
        }
      }
      return { ok: true, headers: { "x-claxedo-session-registration-operation": reservation.operationId } }
    },

    projectSessionMeta: (created) => input.services.projectionStore.put_session_meta(created.sessionId, {
      ws: created.target.workspace,
      host: "workspace",
      workspaceID: created.target.workspace.id,
      title: created.title,
      model: created.model,
    }),
  })
}
