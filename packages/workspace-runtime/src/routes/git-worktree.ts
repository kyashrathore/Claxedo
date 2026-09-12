import { Hono } from "hono"
import { isBoolean, isNonEmptyString, isRecord, isString } from "@claxedo/helpers/guards"
import { parsePositiveInteger } from "@claxedo/helpers"
import { GitTimeoutError } from "../git"
import { assertTarget, WorkspaceTargetError } from "../target"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import {
  GIT_LOG_DEFAULT_LIMIT,
  GitWorktreeError,
  gitCommitStaged,
  gitLog,
  gitPush,
  gitStage,
  gitUnstage,
  gitWorktreeStatus,
} from "../workspace-files/git-worktree"
import { boundedJsonBody, errorBody, isRequestBodyTooLarge, requestBodyTooLargeBody } from "./http"
import { denyWorkspaceViewers } from "./workspace-role"

type GitRouteContext = {
  req: {
    query: (k: string) => string | undefined
    header: (k: string) => string | undefined
  }
}

const WRITE_DENIED = "Workspace role does not allow Git writes"

const ERROR_STATUS = {
  git_empty_message: 400,
  git_nothing_staged: 400,
  git_conflict: 409,
  git_push_rejected: 502,
} as const

function directory(c: GitRouteContext) {
  return assertTarget(c.req.query("directory") || c.req.header("x-claxedo-directory"))
}

function gitRouteFailure(err: unknown) {
  if (err instanceof GitWorktreeError) {
    return { status: ERROR_STATUS[err.code], body: errorBody(err.code, err.message) }
  }
  if (err instanceof WorkspaceTargetError) {
    return { status: 400 as const, body: errorBody("git_invalid_path", err.message) }
  }
  if (err instanceof GitTimeoutError) {
    return { status: 504 as const, body: errorBody("git_timeout", err.message) }
  }
  const stderr = isRecord(err) && isString(err.stderr) ? err.stderr.trim() : undefined
  const message = stderr || (err instanceof Error ? err.message : "git command failed")
  return { status: 400 as const, body: errorBody("git_command_failed", message) }
}

function pathList(body: unknown) {
  const paths = isRecord(body) ? body.paths : undefined
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every(isNonEmptyString)) return undefined
  return paths
}

export function GitWorktreeRoutes() {
  return new Hono<{ Variables: RelayHostAuthContext }>()
    .onError((err, c) => {
      if (isRequestBodyTooLarge(err)) return c.json(requestBodyTooLargeBody(), 413)
      const { status, body } = gitRouteFailure(err)
      return c.json(body, status)
    })
    .get("/status", async (c) => {
      return c.json(await gitWorktreeStatus(directory(c)))
    })
    .get("/log", async (c) => {
      const limit = parsePositiveInteger(c.req.query("limit")) ?? GIT_LOG_DEFAULT_LIMIT
      return c.json({ commits: await gitLog(directory(c), limit) })
    })
    .post("/stage", denyWorkspaceViewers(WRITE_DENIED), async (c) => {
      const paths = pathList(await boundedJsonBody(c))
      if (!paths) return c.json(errorBody("git_paths_required", "paths must be a non-empty string array"), 400)
      await gitStage(directory(c), paths)
      return c.body(null, 204)
    })
    .post("/unstage", denyWorkspaceViewers(WRITE_DENIED), async (c) => {
      const paths = pathList(await boundedJsonBody(c))
      if (!paths) return c.json(errorBody("git_paths_required", "paths must be a non-empty string array"), 400)
      await gitUnstage(directory(c), paths)
      return c.body(null, 204)
    })
    .post("/commit-staged", denyWorkspaceViewers(WRITE_DENIED), async (c) => {
      const body = await boundedJsonBody(c)
      const message = isRecord(body) && isString(body.message) ? body.message : undefined
      const amend = isRecord(body) ? body.amend : undefined
      if (message === undefined) return c.json(errorBody("git_empty_message", "message must be a string"), 400)
      if (amend !== undefined && !isBoolean(amend)) return c.json(errorBody("git_invalid_body", "amend must be a boolean"), 400)
      return c.json(await gitCommitStaged(directory(c), { message, amend }))
    })
    .post("/push", denyWorkspaceViewers(WRITE_DENIED), async (c) => {
      const body = await boundedJsonBody(c)
      const setUpstream = isRecord(body) ? body.setUpstream : undefined
      if (setUpstream !== undefined && !isBoolean(setUpstream)) {
        return c.json(errorBody("git_invalid_body", "setUpstream must be a boolean"), 400)
      }
      return c.json(await gitPush(directory(c), { setUpstream }))
    })
}
