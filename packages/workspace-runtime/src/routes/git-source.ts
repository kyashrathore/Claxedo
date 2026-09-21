import { Hono } from "hono"
import {
  GitSourceConflictError,
  commitGitSource,
  gitSourceSnapshot,
} from "../workspace-files/git-source"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import { rec, str } from "../json-value"
import { boundedJsonRecord, isRequestBodyTooLarge, requestBodyTooLargeBody } from "./http"
import { workspaceDir } from "../target"
import { denyWorkspaceViewers } from "./workspace-role"
import { authorizeWorktreeTarget, type WorktreeTargetAccessOptions } from "./worktree-target-access"
import { trimToUndefined } from "@claxedo/helpers/string"

function error(code: string, message: string, extra?: Record<string, unknown>) {
  return Response.json({ error: { code, message, ...extra } }, { status: code === "git_source_conflict" ? 409 : 400 })
}

export function GitSourceRoutes(options: WorktreeTargetAccessOptions = {}) {
  return new Hono<{ Variables: RelayHostAuthContext }>()
    .onError((err, c) => {
      if (isRequestBodyTooLarge(err)) return c.json(requestBodyTooLargeBody(), 413)
      throw err
    })
    .get("/snapshot", async (c) => {
      const sourcePath = trimToUndefined(c.req.query("path"))
      if (!sourcePath) return error("git_source_path_required", "path is required")
      const denied = await authorizeWorktreeTarget(c, options, {
        operation: "worktree_read",
        directory: workspaceDir(),
        paths: [sourcePath],
      })
      if (denied) return denied
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
      const body = await boundedJsonRecord(c)
      const sourcePath = trimToUndefined(str(body.path))
      const message = trimToUndefined(str(body.message))
      const content = str(body.content)
      const expected = rec(body.expected)
      const baseCommit = str(expected?.baseCommit)
      const baseBlobSha = str(expected?.baseBlobSha)
      if (!sourcePath) return error("git_source_path_required", "path is required")
      if (!message) return error("git_source_message_required", "message is required")
      if (content === undefined) return error("git_source_content_required", "content is required")
      const denied = await authorizeWorktreeTarget(c, options, {
        operation: "worktree_write",
        directory: workspaceDir(),
        paths: [sourcePath],
        // `git add -- <path>` takes a directory as everything under it.
        subtree: true,
      })
      if (denied) return denied
      try {
        return c.json(await commitGitSource({
          path: sourcePath,
          content,
          message,
          expected: {
            ...(baseCommit === undefined ? {} : { baseCommit }),
            ...(baseBlobSha === undefined ? {} : { baseBlobSha }),
          },
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
