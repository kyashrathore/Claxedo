import type { WorkspaceWorktreeRecord } from "../../../../workspace-runtime/src/store"
import {
  parseWorktreeCreateBody,
  worktreeListResponse,
  worktreeResponse,
  WORKTREE_CREATE_SUCCESS_STATUS,
} from "../../../../workspace-runtime/src/routes/worktree"

export { parseWorktreeCreateBody, WORKTREE_CREATE_SUCCESS_STATUS }

export function emptyWorktreeListResponse() {
  return worktreeListResponse([])
}

export function activeWorktreeResponse(input: {
  workspaceId: string
  sessionId: string
  path: string
  branch?: string
  baseCommit?: string
  now?: number
}) {
  const now = input.now ?? Date.now()
  const worktree: WorkspaceWorktreeRecord = {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    path: input.path,
    branch: input.branch ?? `claxedo/session/${input.sessionId}`,
    baseCommit: input.baseCommit ?? "e2e-base-commit",
    state: "active",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  }
  return worktreeResponse(worktree)
}
