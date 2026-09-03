import { Hono, type Context } from "hono"
import { WorkspaceTargetError } from "../target"
import type { WorkspaceWorktreeManager } from "../worktree"
import type { WorkspaceWorktreeRecord } from "../store"
import { errorBody } from "./http"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import {
  sessionAccessContext,
  sessionAccessDenied,
} from "../session-access-policy"
import { authorizeHostCapability, type HostCapabilityAccessOptions } from "./host-capability-access"

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

export function WorktreeRoutes(
  manager: WorkspaceWorktreeManager,
  options: HostCapabilityAccessOptions = {},
) {
  const authorizeSession = async (
    c: Context<{ Variables: RelayHostAuthContext }>,
    operation: "worktree_read" | "worktree_write",
    sessionId: string,
  ) => {
    if (!sessionAccessContext(c).authority && !options.sessionAccessPolicy) return
    if (!options.sessionAccessPolicy) {
      return sessionAccessDenied({
        allowed: false,
        status: 503,
        code: "session_authority_required",
        message: "Workspace worktree authority is unavailable",
      })
    }
    const decision = await options.sessionAccessPolicy.authorize({
      ...sessionAccessContext(c),
      operation,
      sessionId,
      method: c.req.method,
      path: c.req.path,
    })
    if (!decision.allowed) return sessionAccessDenied(decision)
  }

  return new Hono<{ Variables: RelayHostAuthContext }>()
    .get("/", async (c) => {
      const denied = await authorizeHostCapability(c, options, "worktree_read")
      if (denied) return denied
      const worktrees = manager.list()
      if (!options.sessionAccessPolicy || !sessionAccessContext(c).authority) {
        return c.json(worktreeListResponse(worktrees))
      }
      const visible = new Set(await options.sessionAccessPolicy.filterSessions({
        ...sessionAccessContext(c),
        operation: "worktree_read",
        method: c.req.method,
        path: c.req.path,
        sessionIds: worktrees.map((worktree) => worktree.sessionId),
      }))
      return c.json(worktreeListResponse(worktrees.filter((worktree) => visible.has(worktree.sessionId))))
    })
    .get("/:sessionId", async (c) => {
      try {
        const sessionId = c.req.param("sessionId")
        const denied = await authorizeSession(c, "worktree_read", sessionId)
        if (denied) return denied
        const worktree = manager.get(sessionId)
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
        const denied = await authorizeSession(c, "worktree_write", parsed.value.sessionId)
        if (denied) return denied
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
