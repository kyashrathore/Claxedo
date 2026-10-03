import type { SessionProjectionStore } from "@claxedo/server-core/authority/session-projection"
import { onSessionMetaChange } from "@claxedo/server-core/session/meta/index"
import { onHostServingCredential } from "@claxedo/host-serving/serving"
import { localHostSessionRowsUrl } from "../../deployments/local/host-session-authority"
import {
  onEmbeddedWorkspaceRuntime,
  readMountedEmbeddedWorkspaceRuntime,
} from "../../deployments/local/embedded-workspace-runtime"
import { localSessionRowSource } from "./local-session-rows"
import { createRuntimeSessionStatus } from "@claxedo/server-core/session/publish/runtime-session-status"
import { createSessionRowsPublisher } from "@claxedo/server-core/session/publish/session-rows-publisher"

/**
 * The machine publisher, composed over this daemon's own producers: the
 * projection's change notices, the embedded runtimes' frames, and the
 * serving credential and publish URL the heartbeat delivers.
 */
export function startSessionRowsPublisher(
  projectionStore: Pick<SessionProjectionStore, "list_session_metas" | "session_meta">,
): { stop: () => void } {
  const status = createRuntimeSessionStatus({
    observe: onEmbeddedWorkspaceRuntime,
    read: readMountedEmbeddedWorkspaceRuntime,
    onChange: (workspaceId, sessionId) => publisher.sessionChanged(workspaceId, sessionId),
  })
  const publisher = createSessionRowsPublisher({
    source: localSessionRowSource(projectionStore, status),
    url: localHostSessionRowsUrl,
  })
  const unsubscribeChanges = onSessionMetaChange((change) => {
    if (change.kind === "changed") publisher.sessionChanged(change.workspaceId, change.sessionId)
    else if (change.kind === "removed") publisher.sessionRemoved(change.workspaceId, change.sessionId)
    else publisher.workspaceChanged(change.workspaceId)
  })
  const unsubscribeCredential = onHostServingCredential((credential) => publisher.credentialChanged(credential))
  return {
    stop: () => {
      unsubscribeChanges()
      unsubscribeCredential()
      publisher.stop()
      status.stop()
    },
  }
}
