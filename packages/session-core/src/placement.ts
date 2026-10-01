import type { RuntimeDirectory } from "./host/contracts"

export type SessionPlacementPort = {
  workspaceId: string
  directory: string
  canonicalDirectory(directory: string): string
  normalizeDirectory(directory: string): string
  containsDirectory(root: string, candidate: string): boolean
  sessionIdWorkspace(sessionId: string): Promise<string | undefined> | string | undefined
}

export class WorkspaceTargetError extends Error {
  readonly status = 400
  readonly retryable = false
  constructor(message: string, readonly code: "workspace_path_invalid" | "workspace_target_pinned" = "workspace_path_invalid") {
    super(message)
    this.name = "WorkspaceTargetError"
  }
}

export function createSessionPlacement(port: SessionPlacementPort) {
  const directories = new Map<string, string>()
  const normalize = port.normalizeDirectory
  const root = normalize(port.directory)
  return {
    ...port,
    directory: root,
    register(input: { sessionId: string; directory: string }) {
      directories.set(input.sessionId, normalize(input.directory))
    },
    unregister(sessionId: string) { directories.delete(sessionId) },
    registeredDirectory(sessionId: string) { return directories.get(sessionId) },
    registeredDirectories() { return [...directories.values()] },
    entries() { return [...directories].map(([sessionId, directory]) => ({ sessionId, directory })) },
    resolveDirectory(requested?: string, sessionId?: string): RuntimeDirectory {
      if (!requested) return (sessionId ? directories.get(sessionId) : undefined) ?? root
      if (requested.trim() === `workspace:${port.workspaceId}`) return root
      const directory = normalize(requested.trim())
      if (directory === root || [...directories.values()].includes(directory)) return directory
      throw new WorkspaceTargetError(`workspace-runtime is pinned to ${root}`, "workspace_target_pinned")
    },
    clear() { directories.clear() },
  }
}

export type SessionPlacement = ReturnType<typeof createSessionPlacement>
