export type WorkspaceRuntimeSnapshot = {
  workspaceId: string
  projectId?: string | null
  directory?: string
  kind?: "local" | "cloud" | "user-hosted" | null
  provider?: string | null
  sandboxId?: string | null
  status?: string | null
  git?: {
    repo?: string | null
    branch?: string | null
    remote?: string | null
  }
}
