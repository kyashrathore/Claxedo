import { Hono } from "hono"
import { WorkspaceTargetError } from "../target"
import type { WorkspaceWorktreeManager } from "../worktree"
import { errorBody } from "./http"

export function WorktreeRoutes(manager: WorkspaceWorktreeManager) {
  return new Hono()
    .get("/", (c) => c.json({ worktrees: manager.list() }))
    .get("/:sessionId", (c) => {
      try {
        const worktree = manager.get(c.req.param("sessionId"))
        if (!worktree) return c.json(errorBody("worktree_not_found", "Session worktree not found"), 404)
        return c.json({ worktree })
      } catch (error) {
        if (error instanceof WorkspaceTargetError) {
          return c.json(errorBody("worktree_invalid_session", error.message), 400)
        }
        throw error
      }
    })
    .post("/", async (c) => {
      const body = await c.req.json().catch(() => null) as { sessionId?: unknown; baseCommit?: unknown } | null
      if (typeof body?.sessionId !== "string") {
        return c.json(errorBody("worktree_invalid_session", "sessionId is required"), 400)
      }
      if (body.baseCommit !== undefined && typeof body.baseCommit !== "string") {
        return c.json(errorBody("worktree_invalid_base", "baseCommit must be a Git reference"), 400)
      }
      try {
        return c.json({
          worktree: await manager.ensure({
            sessionId: body.sessionId,
            ...(body.baseCommit ? { baseCommit: body.baseCommit } : {}),
          }),
        }, 201)
      } catch (error) {
        if (error instanceof WorkspaceTargetError) {
          return c.json(errorBody("worktree_invalid_session", error.message), 400)
        }
        return c.json(errorBody("worktree_create_failed", error instanceof Error ? error.message : String(error)), 500)
      }
    })
}
