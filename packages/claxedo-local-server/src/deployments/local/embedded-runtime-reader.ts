import type { WorkspaceRuntimeApp, WorkspaceRuntimeServerOptions } from "@claxedo/workspace-runtime"
import type { SessionAttentionFacts } from "@claxedo/agent-runtime-contract"

export type EmbeddedSessionInventory = Parameters<NonNullable<WorkspaceRuntimeServerOptions["bindSessionInventory"]>>[0]

type MountedRuntime = {
  generation: string
  workspace: { directory: string }
  app: WorkspaceRuntimeApp["app"]
  host: WorkspaceRuntimeApp["host"]
  inventory: EmbeddedSessionInventory
}

/** Read-only ports on the currently mounted owner. These reads never acquire or reconcile a runtime. */
export function createEmbeddedRuntimeReader(mounted: (workspaceId: string) => MountedRuntime | undefined) {
  return {
    generation(this: void, workspaceId: string) {
      return mounted(workspaceId)?.generation
    },
    /** Retained, committed root tombstones, including deletions before this daemon started. */
    removed(this: void, workspaceId: string): string[] | undefined {
      return mounted(workspaceId)?.inventory.removed()
    },
    /** Canonical root attention before any asynchronous projection or publication work. */
    attentionSnapshot(this: void, workspaceId: string, sessionId?: string): Array<{ sessionId: string; attention: SessionAttentionFacts }> | undefined {
      const runtime = mounted(workspaceId)
      if (!runtime) return undefined
      const selected = sessionId === undefined ? runtime.inventory.sessions() : [runtime.inventory.session(sessionId)]
      return selected.flatMap((session) => {
        if (!session || session.parentID) return []
        if (!session.attention) throw new Error(`Runtime ${workspaceId} session ${session.id} has no canonical attention`)
        return [{ sessionId: session.id, attention: session.attention }]
      })
    },
    /** Present only when the mounted runtime holds this session's transcript. */
    sessionTime(this: void, workspaceId: string, sessionId: string) {
      return mounted(workspaceId)?.host.sessionTime(sessionId)
    },
    /** Whether only the machine's user has driven this session or a session above it. */
    drivenOnlyByMachineUser(this: void, workspaceId: string, sessionId: string, ownerActorId?: string) {
      return mounted(workspaceId)?.host.drivenOnlyByMachineUser(sessionId, ownerActorId) ?? false
    },
    /** GET as the machine's user. Projection readers must not feed themselves through acquisition. */
    async read(this: void, workspaceId: string, path: string): Promise<Response | undefined> {
      const runtime = mounted(workspaceId)
      if (!runtime) return undefined
      const url = new URL(path, "http://127.0.0.1")
      url.searchParams.set("directory", runtime.workspace.directory)
      return runtime.app.fetch(new Request(url, {
        headers: { "x-workspace-id": workspaceId, "x-claxedo-directory": runtime.workspace.directory },
      }))
    },
    /** Committed session config without consulting operator defaults. */
    sessionConfig(this: void, workspaceId: string, sessionId: string) {
      const config = mounted(workspaceId)?.host.getSessionConfig(sessionId)
      if (!config) throw new Error(`Workspace ${workspaceId} has no committed configuration for session ${sessionId}`)
      return config
    },
  }
}
