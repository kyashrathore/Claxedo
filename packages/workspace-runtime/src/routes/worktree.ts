import { Hono } from "hono"
import { WorkspaceTargetError } from "../target"
import type { WorkspaceWorktreeManager } from "../worktree"
import type { WorkspaceWorktreeRecord } from "../store"
import { errorBody } from "./http"

export const WORKTREE_CREATE_SUCCESS_STATUS = 201 as const

export function worktreeListResponse(worktrees: WorkspaceWorktreeRecord[]) {
  return { worktrees }
}

export function worktreeResponse(worktree: WorkspaceWorktreeRecord) {
  return { worktree }
}

export function parseWorktreeCreateBody(body: unknown):
  | { ok: true; value: { sessionId: string; baseCommit?: string } }
  | { ok: false; status: 400; body: ReturnType<typeof errorBody> } {
  const value = body as { sessionId?: unknown; baseCommit?: unknown } | null
  if (typeof value?.sessionId !== "string") {
    return {
      ok: false,
      status: 400,
      body: errorBody("worktree_invalid_session", "sessionId is required"),
    }
  }
  if (value.baseCommit !== undefined && typeof value.baseCommit !== "string") {
    return {
      ok: false,
      status: 400,
      body: errorBody("worktree_invalid_base", "baseCommit must be a Git reference"),
    }
  }
  return {
    ok: true,
    value: {
      sessionId: value.sessionId,
      ...(value.baseCommit ? { baseCommit: value.baseCommit } : {}),
    },
  }
}

export function WorktreeRoutes(manager: WorkspaceWorktreeManager) {
  return new Hono()
    .get("/", (c) => c.json(worktreeListResponse(manager.list())))
    .get("/:sessionId", (c) => {
      try {
        const worktree = manager.get(c.req.param("sessionId"))
        if (!worktree) return c.json(errorBody("worktree_not_found", "Session worktree not found"), 404)
        return c.json(worktreeResponse(worktree))
      } catch (error) {
        if (error instanceof WorkspaceTargetError) {
          return c.json(errorBody("worktree_invalid_session", error.message), 400)
        }
        throw error
      }
    })
    .post("/", async (c) => {
      const parsed = parseWorktreeCreateBody(await c.req.json().catch(() => null))
      if (!parsed.ok) return c.json(parsed.body, parsed.status)
      try {
        return c.json(
          worktreeResponse(await manager.ensure(parsed.value)),
          WORKTREE_CREATE_SUCCESS_STATUS,
        )
      } catch (error) {
        if (error instanceof WorkspaceTargetError) {
          return c.json(errorBody("worktree_invalid_session", error.message), 400)
        }
        return c.json(errorBody("worktree_create_failed", error instanceof Error ? error.message : String(error)), 500)
      }
    })
}
