import type { SessionProjectionStore } from "@claxedo/server-core/authority/session-projection"
import { onHostServingCredential } from "@claxedo/host-serving/serving"
import { localHostSessionRowsUrl } from "../../deployments/local/host-session-authority"
import {
  onEmbeddedWorkspaceRuntime,
  readMountedEmbeddedWorkspaceRuntime,
} from "../../deployments/local/embedded-workspace-runtime"
import { localSessionRowSource } from "./local-session-rows"
import { createRuntimeSessionStatus } from "./runtime-session-status"
import { observedSessionProjectionStore } from "./session-projection-observer"
import { createSessionRowsPublisher } from "./session-rows-publisher"

/**
 * The machine publisher, composed over this daemon's own producers: the
 * projection store's writes, the embedded runtimes' frames, and the serving
 * credential and publish URL the heartbeat delivers. The store handed back is
 * the one every writer in this process must use, or its writes go unpublished.
 */
export function startSessionRowsPublisher<Store extends SessionProjectionStore>(
  projectionStore: Store,
): { projectionStore: Store; stop: () => void } {
  const status = createRuntimeSessionStatus({
    observe: onEmbeddedWorkspaceRuntime,
    read: readMountedEmbeddedWorkspaceRuntime,
    onChange: (workspaceId, sessionId) => publisher.sessionChanged(workspaceId, sessionId),
  })
  const publisher = createSessionRowsPublisher({
    source: localSessionRowSource(projectionStore, status),
    url: localHostSessionRowsUrl,
  })
  const unsubscribe = onHostServingCredential((credential) => publisher.credentialChanged(credential))
  return {
    projectionStore: observedSessionProjectionStore(projectionStore, publisher),
    stop: () => {
      unsubscribe()
      publisher.stop()
      status.stop()
    },
  }
}
