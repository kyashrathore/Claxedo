import type { PrivateSessionAuthority, PrivateSessionRuntimePrincipal } from "@claxedo/server-core/platform/auth/private-session-authority"
import { CONTROL_PLANE_RUNTIME_ACTOR } from "@claxedo/server-core/platform/auth/runtime-actor"
import {
  chooseProjectWorkspace,
  createTasksSessionBridge,
  type TasksRuntimeTarget,
  type TasksSessionHost,
  type TasksSessionReservation,
} from "@claxedo/server-core/tasks-host/session-bridge-core"
import {
  createWorkspaceRuntimeClient,
  type WorkspaceRuntimeClientOptions,
} from "@claxedo/server-core/workspace/http/workspace-runtime-client"
import { listWorkspaces, resolveWorkspace, type Workspace } from "@claxedo/server-core/workspace/store/index"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import { tasksErrorDetail, type TasksActor, type TasksErrorDetail, type TasksSessionBridgePort } from "@claxedo/tasks"
import { isComposedAuthorityPort } from "../authority/composed-authority"
import type { ControlPlaneServices } from "../authority/services"

export type HostedTasksSessionBridgeInput = {
  services: ControlPlaneServices
  runtimeClient: WorkspaceRuntimeClientOptions
  /**
   * The canonical actor a Start reserves its session for.
   *
   * Session access is granted to the creator actor, a participant row or a
   * share grant, so a session reserved for the control plane's own service
   * actor cannot be opened by the person who started it: Start would report
   * success and the task's link would then read as gone. A Tasks actor cannot
   * answer this — its `ownerId` is a user id, and the reservation records an
   * actor id — so the composition resolves it from the signed caller.
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
      return workspace ? dispatchTarget(workspace, input.runtimeClient) : null
    },

    async projectTarget(projectId) {
      const chosen = chooseProjectWorkspace(projectId, await listWorkspaces().catch(() => []))
      if (!("workspace" in chosen)) return chosen
      const target = dispatchTarget(chosen.workspace, input.runtimeClient)
      return target ? { target } : {
        detail: `Workspace ${chosen.workspace.id} is not reachable from this control plane`,
      }
    },

    sessionMetas: (sessionIds) => input.services.projectionStore.session_metas([...sessionIds]),

    reserve: createTasksSessionReserve(input),

    projectSessionMeta: (created) => input.services.projectionStore.put_session_meta(created.sessionId, {
      ws: created.target.workspace,
      host: "workspace",
      workspaceID: created.target.workspace.id,
      title: created.title,
      model: created.model,
    }),
  })
}

export type TasksSessionReserveInput = {
  services: ControlPlaneServices
  principal?: HostedTasksSessionBridgeInput["principal"]
}

/**
 * The managed reservation a control plane requires before Tasks may create a
 * session, for the hosted bridge and for a signed self-host running the local
 * one: both record a creator actor, and a session reserved for anyone but the
 * person who started it is one they cannot open.
 */
export function createTasksSessionReserve(
  input: TasksSessionReserveInput,
): NonNullable<TasksSessionHost["reserve"]> {
  return async (intent): Promise<TasksSessionReservation> => {
    const authority = input.services.authority ?? undefined
    if (!isComposedAuthorityPort<Pick<PrivateSessionAuthority, "reserveRuntimeSession">>(
      authority,
      ["reserveRuntimeSession"],
    )) {
      return { ok: false, error: tasksErrorDetail("unsupported", "Session registration is unavailable on this host") }
    }
    // The service actor is the fallback for a composition that named no
    // resolver at all. A composition that named one and cannot answer stops
    // here instead: the service actor can write workspaces the caller cannot,
    // so substituting it would take the reservation's own workspace gate off
    // the caller and leave them a session they cannot read.
    const principal = input.principal ? await input.principal(intent.actor) : CONTROL_PLANE_RUNTIME_ACTOR
    if (!principal) {
      return {
        ok: false,
        error: tasksErrorDetail("forbidden", "This host reserves a session for the person starting it, and this caller has no canonical actor"),
      }
    }
    let reservation
    try {
      reservation = await authority.reserveRuntimeSession(principal, {
        operationId: intent.operationId,
        sessionId: intent.sessionId,
        workspaceId: intent.workspaceId,
        kind: "create",
        title: intent.title,
      })
    } catch (error) {
      const refused = reservationRefusal(error)
      if (!refused) throw error
      return refused
    }
    if (reservation.sessionId !== intent.sessionId || reservation.operationId !== intent.operationId) {
      return {
        ok: false,
        error: tasksErrorDetail("conflict", `Origin ${intent.operationId} is reserved for another session`),
      }
    }
    if (reservation.state === "compensation_pending" || reservation.state === "compensated") {
      return {
        ok: false,
        error: tasksErrorDetail("conflict", `Origin ${intent.operationId} was compensated and can no longer register a session`),
      }
    }
    return { ok: true, headers: { "x-claxedo-session-registration-operation": reservation.operationId } }
  }
}

function dispatchTarget(workspace: Workspace, options: WorkspaceRuntimeClientOptions): TasksRuntimeTarget | null {
  try {
    const client = createWorkspaceRuntimeClient({ workspace, options })
    return { workspace, request: (path, init) => client.request(path, init) }
  } catch {
    // A workspace this composition cannot dispatch to — no sandbox manager, no
    // relay, no local runtime in a Worker — is unreachable, not a fault.
    return null
  }
}

/**
 * A reservation refusal the authority owns, as a Start failure rather than an
 * escaping exception: the workspace gate runs there, as the caller, and it
 * answers by throwing. Anything that is not one of its refusals is a fault and
 * keeps travelling.
 */
function reservationRefusal(error: unknown): { ok: false; error: TasksErrorDetail } | null {
  const status = error instanceof ControlPlaneAuthError || error instanceof ClaxedoError ? error.status : undefined
  const message = error instanceof Error ? error.message : "The session reservation was refused"
  if (status === 401 || status === 403) return { ok: false, error: tasksErrorDetail("forbidden", message) }
  if (status === 409) return { ok: false, error: tasksErrorDetail("conflict", message) }
  if (status === 400) return { ok: false, error: tasksErrorDetail("invalid_input", message) }
  return null
}
