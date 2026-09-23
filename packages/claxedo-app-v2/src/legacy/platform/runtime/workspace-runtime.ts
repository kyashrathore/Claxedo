import type { WorkspaceHostKind } from "@/platform/runtime/placement-wire"

export type WorkspaceRuntimeSnapshot = {
  workspaceId: string
  projectId?: string | null
  directory?: string
  kind?: WorkspaceHostKind | null
  provider?: string | null
  sandboxId?: string | null
  status?: string | null
  git?: {
    repo?: string | null
    branch?: string | null
    remote?: string | null
  }
}
