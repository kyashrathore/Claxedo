import { Hono } from "hono"
import { isBoolean, isNonEmptyString, isRecord, isString } from "@claxedo/helpers/guards"
import { parsePositiveInteger } from "@claxedo/helpers"
import { gitTopLevel, GitTimeoutError, withGitWriteLock } from "../git"
import { assertTarget, hasRegisteredWorkspaceDirectories, WorkspaceTargetError } from "../target"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import {
  GIT_LOG_DEFAULT_LIMIT,
  GitWorktreeError,
  gitLog,
  gitPush,
  gitStage,
  gitUnstage,
  gitWorktreeStatus,
  prepareStagedCommit,
} from "../workspace-files/git-worktree"
import { boundedJsonBody, errorBody, isRequestBodyTooLarge, requestBodyTooLargeBody } from "./http"
import { denyWorkspaceViewers } from "./workspace-role"
import {
  authorizeWorktreeTarget,
  deniedWorktreeFilter,
  type WorktreeTargetAccessOptions,
  type WorktreeTargetContext,
  type WorktreeTargetRequest,
} from "./worktree-target-access"

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

export type GitWorktreeRoutesOptions = WorktreeTargetAccessOptions & {
  /** Test-only: runs between the commit being authorized and the commit itself. */
  faults?: Readonly<{ beforeCommit?: () => void | Promise<void> }>
}

export function GitWorktreeRoutes(options: GitWorktreeRoutesOptions = {}) {
  /** The repository this request runs Git in, or the refusal that stands in for it. */
  const scoped = async (
    c: WorktreeTargetContext,
    request: Omit<WorktreeTargetRequest, "directory">,
  ): Promise<string | Response> => {
    const base = directory(c)
    return await authorizeWorktreeTarget(c, options, { ...request, directory: base }) ?? base
  }

  /**
   * Runs a route that changes the index while holding it, so this process's
   * own stage and commit requests take turns: a stage that landed between a
   * commit's snapshot and its write would be left out of the commit it was
   * sent to join.
   *
   * Only when this workspace has per-session worktrees: with none registered
   * there is nothing private for a concurrent write to add, and the key costs
   * a process to resolve. The key is the repository git reports, which is what
   * owns the index — a linked worktree reports itself and has its own.
   */
  const holdingIndex = async <T>(base: string, run: () => Promise<T>): Promise<T> =>
    hasRegisteredWorkspaceDirectories()
      ? await withGitWriteLock(await gitTopLevel(base), run)
      : await run()

  return new Hono<{ Variables: RelayHostAuthContext }>()
    .onError((err, c) => {
      if (isRequestBodyTooLarge(err)) return c.json(requestBodyTooLargeBody(), 413)
      const { status, body } = gitRouteFailure(err)
      return c.json(body, status)
    })
    .get("/status", async (c) => {
      const base = await scoped(c, { operation: "worktree_read" })
      if (typeof base !== "string") return base
      const status = await gitWorktreeStatus(base)
      // Porcelain names every path from the repository and reports all of it,
      // so a worktree that is an ancestor or a sibling of the served directory
      // is in this answer too. `--untracked-files=all` walks the working tree
      // as well. A rename is dropped on either end: the path it came from is a
      // path of that worktree too.
      const visible = await deniedWorktreeFilter(c, options, { directory: base, bases: ["repository"] })
      return c.json({
        ...status,
        staged: status.staged.filter((entry) => visible(entry.path, entry.from)),
        unstaged: status.unstaged.filter((entry) => visible(entry.path, entry.from)),
      })
    })
    .get("/log", async (c) => {
      const base = await scoped(c, { operation: "worktree_read" })
      if (typeof base !== "string") return base
      const limit = parsePositiveInteger(c.req.query("limit")) ?? GIT_LOG_DEFAULT_LIMIT
      return c.json({ commits: await gitLog(base, limit) })
    })
    .post("/stage", denyWorkspaceViewers(WRITE_DENIED), async (c) => {
      const paths = pathList(await boundedJsonBody(c))
      if (!paths) return c.json(errorBody("git_paths_required", "paths must be a non-empty string array"), 400)
      const base = await scoped(c, { operation: "worktree_write", paths, subtree: true })
      if (typeof base !== "string") return base
      await holdingIndex(base, () => gitStage(base, paths))
      return c.body(null, 204)
    })
    .post("/unstage", denyWorkspaceViewers(WRITE_DENIED), async (c) => {
      const paths = pathList(await boundedJsonBody(c))
      if (!paths) return c.json(errorBody("git_paths_required", "paths must be a non-empty string array"), 400)
      const base = await scoped(c, { operation: "worktree_write", paths, subtree: true })
      if (typeof base !== "string") return base
      await holdingIndex(base, () => gitUnstage(base, paths))
      return c.body(null, 204)
    })
    .post("/commit-staged", denyWorkspaceViewers(WRITE_DENIED), async (c) => {
      const body = await boundedJsonBody(c)
      const message = isRecord(body) && isString(body.message) ? body.message : undefined
      const amend = isRecord(body) ? body.amend : undefined
      if (message === undefined) return c.json(errorBody("git_empty_message", "message must be a string"), 400)
      if (amend !== undefined && !isBoolean(amend)) return c.json(errorBody("git_invalid_body", "amend must be a boolean"), 400)
      const base = await scoped(c, { operation: "worktree_write" })
      if (typeof base !== "string") return base
      return await holdingIndex(base, async () => {
        const staged = await prepareStagedCommit(base, { message, amend })
        // The request names a message; the index names the files. Whatever
        // put them there, publishing them is this caller's act.
        if (hasRegisteredWorkspaceDirectories()) {
          const denied = await authorizeWorktreeTarget(c, options, {
            operation: "worktree_write",
            directory: base,
            resolved: await staged.affectedPaths(),
          })
          if (denied) return denied
        }
        await options.faults?.beforeCommit?.()
        return c.json(await staged.commit())
      })
    })
    .post("/push", denyWorkspaceViewers(WRITE_DENIED), async (c) => {
      const body = await boundedJsonBody(c)
      const setUpstream = isRecord(body) ? body.setUpstream : undefined
      if (setUpstream !== undefined && !isBoolean(setUpstream)) {
        return c.json(errorBody("git_invalid_body", "setUpstream must be a boolean"), 400)
      }
      const base = directory(c)
      // A push sends the branch, not a file list, so there is no path to
      // narrow it by: the target is the whole repository, and the question is
      // whether this caller may act for every session whose work it carries.
      const tree = hasRegisteredWorkspaceDirectories() ? await gitTopLevel(base) : base
      const denied = await authorizeWorktreeTarget(c, options, {
        operation: "worktree_write",
        directory: base,
        paths: [tree],
        subtree: true,
      })
      if (denied) return denied
      return c.json(await gitPush(base, { setUpstream }))
    })
}
