import type { SessionRef } from "@claxedo/agent-runtime-contract"
import type { HostSessionRowsPublication } from "./host-session-rows"

/** One cloud runtime launch, named by a control-plane-minted producer pass. */
export type CloudSessionRowsPublisher = {
  workspaceId: string
  hostId: string
  epoch: number
  userId: string
  actorId: string
  orgId: string
  projectId: string
}

export type CloudSessionRowsResult = {
  accepted: number
  refused: Array<SessionRef & {
    reason: "workspace_not_served" | "session_elsewhere" | "session_deleted" | "session_unregistered" | "attention_boundary_changed"
  }>
}

export type CloudSessionRowsAuthority = {
  cloudSessionRowsPublisherActive(publisher: CloudSessionRowsPublisher): Promise<boolean>
  publishCloudSessionRows(
    publisher: CloudSessionRowsPublisher,
    publication: HostSessionRowsPublication,
  ): Promise<CloudSessionRowsResult>
}
