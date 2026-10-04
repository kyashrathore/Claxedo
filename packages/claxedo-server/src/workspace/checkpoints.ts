import { workspaceRuntimeRequestError } from "@claxedo/server-core/workspace/http/workspace-runtime-client"
import type {
  SandboxCheckpointCaptureInput,
  SandboxCheckpointRestoreInput,
  SandboxCheckpointRuntime,
  SandboxManager,
  SandboxStopInput,
} from "@claxedo/sandbox-manager"
import { readJsonRecord } from "@claxedo/server-core/platform/json/index"

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
        lease,
        checkpoint: lease?.checkpoint,
        restore: lease?.restore,
        capabilities: lease?.persistence,
        worktrees,
        runtime: {
          image: lease?.labels?.image ?? lease?.labels?.runtimeImage,
          version: lease?.labels?.runtimeVersion ?? lease?.labels?.workspaceRuntimeVersion,
        },
      }
    },
    capture(workspaceId: string, request: Omit<SandboxCheckpointCaptureInput, "runtime"> = {}) {
      return input.sandboxManager.checkpoint(workspaceId, {
        ...request,
        runtime: runtime(workspaceId),
      })
    },
    restore(workspaceId: string, request: Omit<SandboxCheckpointRestoreInput, "runtime"> = {}) {
      return input.sandboxManager.restore(workspaceId, {
        ...request,
        runtime: runtime(workspaceId),
      })
    },
    /** Captures and stops a running workspace; the runtime it controls must already run, so it is reached without waking it. */
    stop(workspaceId: string, request: Omit<SandboxStopInput, "runtime"> = {}) {
      return input.sandboxManager.stop(workspaceId, {
        ...request,
        runtime: runtime(workspaceId, input.inspectRuntimeRequest ?? input.runtimeRequest),
      })
    },
    replace(workspaceId: string, request: Omit<SandboxCheckpointRestoreInput, "runtime"> = {}) {
      return input.sandboxManager.restore(workspaceId, {
        ...request,
        runtime: runtime(workspaceId),
      })
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
