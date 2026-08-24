import { storePath } from "solid-js"
// Workspace slice — paneWorktree, recency, worktree colors, deletion cleanup.
//
// Owns per-pane workspace defaults, workspace recency, colors, and deletion cleanup.

import type { StoreSetter } from "solid-js"
import type { ClaxedoState } from "./types"

const WORKTREE_COLORS = [
  "#3b82f6", // blue
  "#22c55e", // green
  "#a855f7", // purple
  "#f97316", // orange
  "#ec4899", // pink
  "#14b8a6", // teal
  "#f59e0b", // amber
  "#6366f1", // indigo
  "#ef4444", // red
  "#06b6d4", // cyan
]

export type PaneWorktreeEntry = { default: string | null; pinned: string | null }

export type WorkspaceSliceApi = {
  // ── paneWorktree ────────────────────────────────────────────────────────
  paneWorktree(paneId: string): PaneWorktreeEntry
  setPaneWorktreeDefault(paneId: string, directory: string | null): void
  setPaneWorktreePinned(paneId: string, directory: string | null): void

  // ── recency ─────────────────────────────────────────────────────────────
  /** Most-recently accessed worktree directories for a project. */
  recency(projectId: string, limit?: number): string[]
  recordAccess(projectId: string, workspaceDir: string): void
  cleanupRecency(projectId: string, validWorkspaces: string[]): void

  // ── colors ──────────────────────────────────────────────────────────────
  getColor(directory: string): string
  getWorktreeName(directory: string): string

  // ── cleanup ─────────────────────────────────────────────────────────────
  /**
   * Remove all references to a deleted worktree from the state.
   * Caller is responsible for separately closing any orphaned content via the
   * orchestration `closeContent` API; this only zeros worktree fields.
   */
  cleanupDeletedWorktree(directory: string, projectId?: string): void
}

export function createWorkspaceSlice(input: {
  state: ClaxedoState
  setState: StoreSetter<ClaxedoState>
}): WorkspaceSliceApi {
  const { state, setState } = input

  const paneWorktree = (paneId: string): PaneWorktreeEntry => {
    return state.workspace.paneWorktree[paneId] ?? { default: null, pinned: null }
  }

  const setPaneWorktreeDefault = (paneId: string, directory: string | null) => {
    const existing = state.workspace.paneWorktree[paneId] ?? { default: null, pinned: null }
    setState(storePath("workspace", "paneWorktree", paneId, { ...existing, default: directory }))
  }

  const setPaneWorktreePinned = (paneId: string, directory: string | null) => {
    const existing = state.workspace.paneWorktree[paneId] ?? { default: null, pinned: null }
    setState(storePath("workspace", "paneWorktree", paneId, { ...existing, pinned: directory }))
  }

  const recency = (projectId: string, limit = 5) => {
    const list = state.workspace.recency[projectId] ?? []
    return list.slice(0, limit)
  }

  const recordAccess = (projectId: string, workspaceDir: string) => {
    const current = state.workspace.recency[projectId] ?? []
    const filtered = current.filter((dir) => dir !== workspaceDir)
    setState(storePath("workspace", "recency", projectId, [workspaceDir, ...filtered]))
  }

  const cleanupRecency = (projectId: string, validWorkspaces: string[]) => {
    const current = state.workspace.recency[projectId] ?? []
    const valid = new Set(validWorkspaces)
    const cleaned = current.filter((dir) => valid.has(dir))
    if (cleaned.length !== current.length) {
      setState(storePath("workspace", "recency", projectId, cleaned))
    }
  }

  const getColor = (directory: string): string => {
    const existing = state.workspace.worktreeColor[directory]
    if (existing) return existing
    const used = new Set(Object.values(state.workspace.worktreeColor))
    let color = WORKTREE_COLORS.find((c) => !used.has(c))
    if (!color) {
      let hash = 0
      for (let i = 0; i < directory.length; i++) {
        const char = directory.charCodeAt(i)
        hash = (hash << 5) - hash + char
        hash = hash & hash
      }
      color = WORKTREE_COLORS[Math.abs(hash) % WORKTREE_COLORS.length]
    }
    setState(storePath("workspace", "worktreeColor", directory, color))
    return color
  }

  const getWorktreeName = (directory: string): string => {
    const parts = directory.split("/")
    return parts[parts.length - 1] || parts[parts.length - 2] || "unknown"
  }

  const cleanupDeletedWorktree = (directory: string, projectId?: string) => {
    void (() => {
      // Drop paneWorktree entries pointing at this directory.
      for (const [paneId, entry] of Object.entries(state.workspace.paneWorktree)) {
        if (!entry) continue
        const next: PaneWorktreeEntry = {
          default: entry.default === directory ? null : entry.default,
          pinned: entry.pinned === directory ? null : entry.pinned,
        }
        if (next.default !== entry.default || next.pinned !== entry.pinned) {
          setState(storePath("workspace", "paneWorktree", paneId, next))
        }
      }

      // Recency
      if (projectId) {
        const current = state.workspace.recency[projectId] ?? []
        const cleaned = current.filter((dir) => dir !== directory)
        if (cleaned.length !== current.length) {
          setState(storePath("workspace", "recency", projectId, cleaned))
        }
      }

      // Free the color so it can be reused.
      if (state.workspace.worktreeColor[directory]) {
        // as-any: Solid store uses undefined here to clear an indexed string entry.
        setState(storePath("workspace", "worktreeColor", directory, undefined as unknown as string))
      }
    })()
  }

  return {
    paneWorktree,
    setPaneWorktreeDefault,
    setPaneWorktreePinned,
    recency,
    recordAccess,
    cleanupRecency,
    getColor,
    getWorktreeName,
    cleanupDeletedWorktree,
  }
}
