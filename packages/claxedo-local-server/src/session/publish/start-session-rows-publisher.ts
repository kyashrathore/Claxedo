import type { SessionProjectionStore } from "@claxedo/server-core/authority/session-projection"
import { onSessionMetaChange } from "@claxedo/server-core/session/meta/index"
import { onHostServingCredential } from "@claxedo/host-serving/serving"
import { localHostSessionRowsUrl } from "../../deployments/local/host-session-authority"
import {
  onEmbeddedWorkspaceRuntime,
  readMountedEmbeddedWorkspaceRuntime,
  ensureEmbeddedWorkspaceRuntime,
  embeddedWorkspaceRuntimeGeneration,
} from "../../deployments/local/embedded-workspace-runtime"
import { localSessionRowSource } from "./local-session-rows"
import { createRuntimeSessionStatus } from "./runtime-session-status"
import { createSessionRowsPublisher } from "./session-rows-publisher"
import { projectSessionAttention } from "./project-session-attention"
import { createLocalSessionAttentionPublisher } from "./local-attention-publisher"
import { listWorkspaces, resolveWorkspace } from "@claxedo/server-core/workspace/store/index"

/**
 * The machine publisher, composed over this daemon's own producers: the
 * projection's change notices, the embedded runtimes' frames, and the
 * serving credential and publish URL the heartbeat delivers.
 */
export function startSessionRowsPublisher(
  projectionStore: Pick<SessionProjectionStore, "list_session_metas" | "session_meta" | "sync_session_meta">,
): { stop: () => void } {
  let localAttention: ReturnType<typeof createLocalSessionAttentionPublisher> | undefined
  const status = createRuntimeSessionStatus({
    observe: onEmbeddedWorkspaceRuntime,
    read: readMountedEmbeddedWorkspaceRuntime,
    onChange: (workspaceId, sessionId) => {
      void projectSessionAttention(projectionStore, workspaceId, sessionId)
        .then(async () => {
          publisher.sessionChanged(workspaceId, sessionId)
          await localAttention?.sessionChanged(workspaceId, sessionId)
        })
        .catch((error) => console.error("Session attention projection failed", { workspaceId, sessionId, error }))
    },
  })
  const source = localSessionRowSource(projectionStore, status,
    (workspaceId, sessionId) => projectSessionAttention(projectionStore, workspaceId, sessionId),
    async (workspaceId) => {
      if (embeddedWorkspaceRuntimeGeneration(workspaceId) !== undefined) return
      const workspace = await resolveWorkspace({ workspaceId })
      if (!workspace) throw new Error(`Workspace ${workspaceId} is unavailable`)
      await ensureEmbeddedWorkspaceRuntime(workspace, { config: "skip" })
    })
  const publisher = createSessionRowsPublisher({
    source,
    url: localHostSessionRowsUrl,
  })
  const unsubscribeOrigins = onEmbeddedWorkspaceRuntime((runtime, phase) => {
    if (phase === "mounted") publisher.workspaceMounted(runtime.workspace.id)
  })
  localAttention = createLocalSessionAttentionPublisher({
    source,
    projection: projectionStore,
    workspaceIds: async () => (await listWorkspaces()).filter((workspace) => workspace.kind !== "cloud").map((workspace) => workspace.id),
  })
  void localAttention.start().catch((error) => console.error("Local attention recovery incomplete", { error }))
  const unsubscribeChanges = onSessionMetaChange((change) => {
    if (change.kind === "changed") {
      publisher.sessionChanged(change.workspaceId, change.sessionId)
      void localAttention?.sessionChanged(change.workspaceId, change.sessionId).catch((error) => console.error("Local attention publication failed", { change, error }))
    }
    else if (change.kind === "removed") publisher.sessionRemoved(change.workspaceId, change.sessionId)
    else {
      publisher.workspaceChanged(change.workspaceId)
      void localAttention?.workspaceChanged(change.workspaceId).catch((error) => console.error("Local attention snapshot failed", { change, error }))
    }
  })
  const unsubscribeCredential = onHostServingCredential((credential) => publisher.credentialChanged(credential))
  return {
    stop: () => {
      unsubscribeChanges()
      unsubscribeCredential()
      unsubscribeOrigins()
      publisher.stop()
      status.stop()
      localAttention?.stop()
    },
  }
}
