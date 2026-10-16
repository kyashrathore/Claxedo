import { workspaceRuntimeRequestError } from "@claxedo/server-core/workspace/http/workspace-runtime-client"
import type {
  SandboxCheckpointCaptureInput,
  SandboxCheckpointReference,
  SandboxCheckpointRestoreInput,
  SandboxCheckpointResult,
  SandboxCheckpointRuntime,
  SandboxLease,
  SandboxManager,
  SandboxStopInput,
} from "@claxedo/sandbox-manager"
import { readJsonRecord } from "@claxedo/server-core/platform/json/index"

/**
 * A checkpoint as its readers see it. The provider reference is the snapshot
 * handle a driver restores from, which works as a bearer handle at the
 * provider, so it stays between the lease store and the driver.
 */
function publicCheckpoint(checkpoint: SandboxCheckpointReference | undefined) {
  if (!checkpoint) return undefined
  const { providerReference: _handle, ...rest } = checkpoint
  return rest
}

function publicLease(lease: SandboxLease | undefined) {
  if (!lease) return undefined
  const { checkpoint, ...rest } = lease
  return { ...rest, ...(checkpoint ? { checkpoint: publicCheckpoint(checkpoint) } : {}) }
}

function publicResult(result: SandboxCheckpointResult) {
  return { ...result, lease: publicLease(result.lease), checkpoint: publicCheckpoint(result.checkpoint) }
}

export type WorkspaceCheckpointService = ReturnType<typeof createWorkspaceCheckpointService>

export function createWorkspaceCheckpointService(input: {
  sandboxManager: SandboxManager
  runtimeRequest: (workspaceId: string, path: string, init?: RequestInit) => Promise<Response>
  inspectRuntimeRequest?: (workspaceId: string, path: string, init?: RequestInit) => Promise<Response>
}) {
  const runtime = (workspaceId: string, runtimeRequest = input.runtimeRequest): SandboxCheckpointRuntime => {
    const request = async (path: string, body?: unknown) => {
      const response = await runtimeRequest(workspaceId, path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      })
      if (response.ok) return
      throw await workspaceRuntimeRequestError(path, response)
    }
    return {
      freeze: async (policy, options) => {
        await request("/api/wr/checkpoint/freeze", { policy, ...options })
      },
      flush: async () => {
        await request("/api/wr/checkpoint/flush")
      },
      scrub: async () => {
        await request("/api/wr/checkpoint/scrub")
      },
      resume: async () => {
        await request("/api/wr/checkpoint/resume")
      },
      reconcile: async (body) => {
        await request("/api/wr/checkpoint/restore-reconcile", body)
      },
    }
  }

  return {
    async inspect(workspaceId: string) {
      const lease = (await input.sandboxManager.list()).find((item) => item.workspaceId === workspaceId)
      const worktrees = lease?.status === "ready"
        ? await (input.inspectRuntimeRequest ?? input.runtimeRequest)(workspaceId, "/api/wr/worktrees", { method: "GET" })
          .then(async (response) => {
            const worktrees = response.ok ? (await readJsonRecord(response))?.worktrees : undefined
            return Array.isArray(worktrees) ? worktrees : []
          })
          .catch(() => [])
        : []
      return {
        lease: publicLease(lease),
        checkpoint: publicCheckpoint(lease?.checkpoint),
        restore: lease?.restore,
        capabilities: lease?.persistence,
        worktrees,
        runtime: {
          image: lease?.labels?.image ?? lease?.labels?.runtimeImage,
          version: lease?.labels?.runtimeVersion ?? lease?.labels?.workspaceRuntimeVersion,
        },
      }
    },
    async capture(workspaceId: string, request: Omit<SandboxCheckpointCaptureInput, "runtime"> = {}) {
      return publicResult(await input.sandboxManager.checkpoint(workspaceId, {
        ...request,
        runtime: runtime(workspaceId),
      }))
    },
    async restore(workspaceId: string, request: Omit<SandboxCheckpointRestoreInput, "runtime"> = {}) {
      return publicResult(await input.sandboxManager.restore(workspaceId, {
        ...request,
        runtime: runtime(workspaceId),
      }))
    },
    /** Captures and stops a running workspace; the runtime it controls must already run, so it is reached without waking it. */
    stop(workspaceId: string, request: Omit<SandboxStopInput, "runtime"> = {}) {
      return input.sandboxManager.stop(workspaceId, {
        ...request,
        runtime: runtime(workspaceId, input.inspectRuntimeRequest ?? input.runtimeRequest),
      })
    },
    async replace(workspaceId: string, request: Omit<SandboxCheckpointRestoreInput, "runtime"> = {}) {
      return publicResult(await input.sandboxManager.restore(workspaceId, {
        ...request,
        runtime: runtime(workspaceId),
      }))
    },
    async cleanup(workspaceId: string) {
      const destroyed = await input.sandboxManager.destroy(workspaceId)
      if (!destroyed.ok) return destroyed
      return { ...destroyed, ...(await input.sandboxManager.release(workspaceId)) }
    },
    destroy(workspaceId: string) {
      return input.sandboxManager.destroy(workspaceId)
    },
  }
}
