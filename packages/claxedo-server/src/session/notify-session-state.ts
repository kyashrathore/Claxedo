import type { SessionReaderState, SessionRef } from "@claxedo/agent-runtime-contract"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"

export async function notifySessionReaderChanged(input: {
  auth: SignedControlPlaneAuth
  authority: Pick<WorkspaceAuthority, "listSessionStateNotices">
  ref: SessionRef
  reader: SessionReaderState
  sink: (event: ControlPlaneEvent) => Promise<unknown>
  now: number
}) {
  const userId = input.auth.principal?.userId
  if (!userId) throw new ControlPlaneAuthError(503, "identity_provisioning", "Canonical application identity is required")
  if (!input.authority.listSessionStateNotices) {
    throw new ClaxedoError({ status: 503, code: "session_reader_notifications_unavailable", message: "Session reader notifications are unavailable" })
  }
  const notices = await input.authority.listSessionStateNotices([input.ref])
  for (const notice of notices) {
    for (const recipient of notice.recipients) {
      if (recipient.userId !== userId) continue
      await input.sink({ type: "session.reader.changed", sessionId: notice.sessionId, workspaceId: notice.workspaceId,
        projectId: notice.projectId, orgId: notice.orgId, ownerUserId: recipient.userId, reader: input.reader, ts: input.now })
    }
  }
}
