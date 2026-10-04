import { Hono } from "hono"
import {
  GitSourceConflictError,
  commitGitSource,
  gitSourceSnapshot,
} from "../workspace-files/git-source"
import type { RelayHostAuthContext } from "@claxedo/session-core/relay-host"
import { asRecord, asString } from "@claxedo/helpers/guards"
import { boundedJsonRecord, isRequestBodyTooLarge, requestBodyTooLargeBody } from "@claxedo/session-core"
import { workspaceDir } from "../target"
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
    .post("/commit", async (c) => {
      const body = await boundedJsonRecord(c)
      const sourcePath = trimToUndefined(asString(body.path))
      const message = trimToUndefined(asString(body.message))
      const content = asString(body.content)
      const expected = asRecord(body.expected)
      const baseCommit = asString(expected?.baseCommit)
      const baseBlobSha = asString(expected?.baseBlobSha)
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
