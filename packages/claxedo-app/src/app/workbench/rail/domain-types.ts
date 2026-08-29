/**
 * Rail domain types — the canonical Project / Session / Workspace shapes.
 *
 * These are the fundamental domain vocabulary consumed by the entire
 * layout-actions/ business-logic layer, the rail sidebar rendering component,
 * and the workspace/project integrity specs. They live here — in a
 * dependency-free module with no SolidJS or rendering imports — so the
 * headless actions layer never has to depend on the giant rail-sidebar.tsx
 * presentation component for its type vocabulary.
 *
 * rail-sidebar.tsx re-exports these for back-compat; new code should import
 * directly from this module.
 */

export type RuntimeKind = "local" | "cloud" | "user-hosted"

export type SessionItem = {
  id: string
  sessionRef?: string
  title?: string
  time?: number
  directory?: string
  workspaceId?: string
  projectID?: string
  projectName?: string
  workspaceName?: string
  tags?: string[]
  attachments?: Array<{ kind: string; targetID: string }>
  environment?: { kind?: string; driver?: string }
  git?: { repo?: string; branch?: string; remote?: string }
  owner?: {
    name?: string
    avatarUrl?: string
    publicId?: string
  }
}

export type WorkspaceItem = {
  id: string
  directory: string
  workspaceId?: string
  workspaceName?: string
  name?: string
  isMain?: boolean
  projectWorktree?: string
  isCloud?: boolean
  canDelete?: boolean
  available?: boolean
}

export type WorkspaceInfo = {
  id: string
  workspaceId?: string
  workspace_name?: string
  directory: string
  kind: RuntimeKind
  available?: boolean
  provider?: string
  status?: string
  sandbox_id?: string
  remote_directory?: string
  repo_url?: string
}

export type ProjectItem = {
  id: string
  worktree: string
  name?: string
  icon?: {
    url?: string
    override?: string
    color?: string
  }
  expanded?: boolean
  sandboxes?: string[]
  workspaces?: Record<string, WorkspaceInfo>
  commands?: { start?: string }
}
