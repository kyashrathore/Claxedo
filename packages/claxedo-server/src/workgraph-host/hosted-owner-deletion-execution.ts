import type { SandboxManager } from "@claxedo/sandbox-manager"
import type { WorkspaceExecutionPort } from "@claxedo/workgraph/ports"

export function createHostedOwnerDeletionExecution(
  sandboxManager: SandboxManager | undefined,
): Pick<WorkspaceExecutionPort, "cleanup"> {
  return {
    cleanup: async (_context, input) => {
      if (!sandboxManager) throw new Error("Hosted WorkGraph workspace cleanup requires a sandbox manager")
      for (const workspaceId of [...(input.childIsolationIds ?? []), input.envelopeId]) {
        const result = await sandboxManager.destroy(workspaceId)
        if (!result.ok && result.reason !== "runtime_lease_missing") {
          throw new Error(`Hosted WorkGraph workspace cleanup failed: ${result.reason}`)
        }
        if (result.ok) await sandboxManager.release(workspaceId)
      }
    },
  }
}
