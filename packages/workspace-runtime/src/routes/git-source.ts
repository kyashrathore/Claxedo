import { Hono } from "hono"
import {
  GitSourceConflictError,
  commitGitSource,
  gitSourceSnapshot,
} from "../workspace-files/git-source"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import { denyWorkspaceViewers } from "./workspace-role"

function error(code: string, message: string, extra?: Record<string, unknown>) {
  return Response.json({ error: { code, message, ...(extra ?? {}) } }, { status: code === "git_source_conflict" ? 409 : 400 })
}

function clean(input?: string | null) {
  const value = input?.trim()
  return value ? value : undefined
}

export function GitSourceRoutes() {
  return new Hono<{ Variables: RelayHostAuthContext }>()
    .get("/snapshot", async (c) => {
      const sourcePath = clean(c.req.query("path"))
      if (!sourcePath) return error("git_source_path_required", "path is required")
      try {
        const info = await gitSourceSnapshot(sourcePath)
        if (!info.tracked || info.dirty) {
          return Response.json({
            error: {
              code: "git_source_conflict",
              message: info.dirty ? "source file is dirty" : "source file is untracked",
            },
            currentCommit: info.head,
            currentBlobSha: info.blobSha,
            dirty: info.dirty,
          }, { status: 409 })
        }
        return c.json(info)
      } catch (err) {
        return error("git_source_invalid_path", err instanceof Error ? err.message : "invalid path")
      }
    })
    .post("/commit", denyWorkspaceViewers("Workspace role does not allow Git writes"), async (c) => {
      const body = await c.req.json<{
        path?: string
        content?: string
        message?: string
        expected?: { baseCommit?: string; baseBlobSha?: string }
      }>().catch(() => ({} as {
        path?: string
        content?: string
        message?: string
        expected?: { baseCommit?: string; baseBlobSha?: string }
      }))
      const sourcePath = clean(body.path)
      const message = clean(body.message)
      if (!sourcePath) return error("git_source_path_required", "path is required")
      if (!message) return error("git_source_message_required", "message is required")
      if (typeof body.content !== "string") return error("git_source_content_required", "content is required")
      const content = body.content
      try {
        return c.json(await commitGitSource({
          path: sourcePath,
          content,
          message,
          expected: body.expected,
        }))
      } catch (err) {
        if (err instanceof GitSourceConflictError) {
          return Response.json({
            error: {
              code: "git_source_conflict",
              message: err.message,
            },
            ...err.evidence,
          }, { status: 409 })
        }
        return error("git_source_invalid_path", err instanceof Error ? err.message : "invalid path")
      }
    })
}
