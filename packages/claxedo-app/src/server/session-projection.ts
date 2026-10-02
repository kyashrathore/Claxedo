import { toAppError } from "./errors"
import type { ServerEvent } from "./events"
import type { SessionLocation } from "./types"
import type { Workspaces } from "./workspaces"
import type { HostedAccount } from "./account"

type Action = "register" | "checkpoint"
type Reason = "session-created" | "message-checkpoint"

export type SessionProjection = {
  readonly created: (ref: SessionLocation) => Promise<void>
  readonly observe: (event: ServerEvent) => void
}

export function createSessionProjection(workspaces: Workspaces, account: HostedAccount | undefined): SessionProjection {
  const pull = async (ref: SessionLocation, action: Action, reason: Reason, idempotencyKey: string) => {
    if (!account || workspaces.byId(ref.placementId)?.kind !== "cloud") return
    try {
      const { workspaceId } = await workspaces.locate(ref.placementId)
      await account.run(action === "register" ? "session.projection.register" : "session.projection.checkpoint", { workspaceId, sessionId: ref.sessionId, idempotencyKey, reason })
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
