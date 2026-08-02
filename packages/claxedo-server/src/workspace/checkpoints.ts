import type {
  SandboxCheckpointCaptureInput,
  SandboxCheckpointReference,
  SandboxCheckpointRestoreInput,
  SandboxCheckpointRuntime,
  SandboxManager,
} from "@claxedo/sandbox-manager"

export type WorkspaceCheckpointService = ReturnType<typeof createWorkspaceCheckpointService>

export function createWorkspaceCheckpointService(input: {
  sandboxManager: SandboxManager
  runtimeRequest: (workspaceId: string, path: string, init?: RequestInit) => Promise<Response>
  inspectRuntimeRequest?: (workspaceId: string, path: string, init?: RequestInit) => Promise<Response>
}) {
  const runtime = (workspaceId: string): SandboxCheckpointRuntime => {
    const request = async (path: string, body?: unknown) => {
      const response = await input.runtimeRequest(workspaceId, path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      })
      if (response.ok) return
      throw new Error(await response.text() || `Workspace runtime checkpoint request failed: ${response.status}`)
    }
    return {
      freeze: async (policy) => {
        await request("/api/wr/checkpoint/freeze", { policy })
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
          .then(async (response) => response.ok
            ? (await response.json() as { worktrees?: unknown[] }).worktrees ?? []
            : [])
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
    async stop(workspaceId: string) {
      const lease = (await input.sandboxManager.list()).find((item) => item.workspaceId === workspaceId)
      if (lease?.status === "ready" && lease.persistence && lease.persistence.capture !== "none") {
        const captured = await input.sandboxManager.checkpoint(workspaceId, {
          runtime: runtime(workspaceId),
          policy: "drain",
        })
        if (captured.lease.status === "stopped") return { ok: true as const, status: "stopped" as const }
      }
      return await input.sandboxManager.stop(workspaceId)
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

export function latestWorkspaceCheckpoint(input: Awaited<ReturnType<WorkspaceCheckpointService["inspect"]>>) {
  return input.checkpoint as SandboxCheckpointReference | undefined
}
