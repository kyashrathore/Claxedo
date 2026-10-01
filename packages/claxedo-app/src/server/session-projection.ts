import { toAppError } from "./errors"
import type { ServerEvent } from "./events"
import type { Transport } from "./transport"
import type { SessionLocation } from "./types"
import type { Workspaces } from "./workspaces"

type Action = "register" | "checkpoint"
type Reason = "session-created" | "message-checkpoint"

export type SessionProjection = {
  readonly created: (ref: SessionLocation) => Promise<void>
  readonly observe: (event: ServerEvent) => void
}

function endpoint(workspaceId: string, ref: SessionLocation, action: Action) {
  return `/api/control/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(ref.sessionId)}/${action}`
}

export function createSessionProjection(transport: Transport, workspaces: Workspaces): SessionProjection {
  const held = (ref: SessionLocation) => {
    const catalog = workspaces.catalog()
    const placement = workspaces.byId(ref.placementId)
    return catalog?.declaration.issuesSessions === true && placement?.kind === "cloud"
  }
  const pull = async (ref: SessionLocation, action: Action, reason: Reason, idempotencyKey: string) => {
    if (!held(ref)) return
    try {
      const { workspaceId } = await workspaces.locate(ref.placementId)
      await transport.json<unknown>(endpoint(workspaceId, ref, action), { method: "POST", body: JSON.stringify({ idempotencyKey, reason }) })
    } catch (error) {
      console.warn("The control plane could not store a cloud session", { sessionId: ref.sessionId, action, error: toAppError(error) })
    }
  }
  return {
    created: (ref) => pull(ref, "register", "session-created", `session-created:${ref.placementId}:${ref.sessionId}`),
    observe: (event) => {
      if (event.type !== "statusChanged" || (event.status.kind !== "idle" && event.status.kind !== "failed")) return
      void pull(event.ref, "checkpoint", "message-checkpoint", `message-checkpoint:${event.ref.sessionId}:${Date.now()}`)
    },
  }
}
