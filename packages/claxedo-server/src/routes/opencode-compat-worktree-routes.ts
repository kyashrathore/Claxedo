import fs from "fs"
import type { Context } from "hono"
import path from "path"
import { deleteWorkspaceByDirectory, getProjectWorkspace, listWorkspaces, resolveWorkspace } from "../workspace-store"
import { errorBody } from "./http"
import { workspaceInput } from "./opencode-compat-context"
import { contains, defaultBranch, gitRun, locate, shell, trees } from "./opencode-compat-git"
import { dataDir } from "../paths"
import { nextWorktreeInfo, publishWorktreeFailed, publishWorktreeReady } from "./opencode-compat-worktree"
import { provisionRegisteredWorktree, WorktreeProvisionError } from "../worktree-service"

type WorktreeInfo = NonNullable<Awaited<ReturnType<typeof nextWorktreeInfo>>>

/**
 * The only two directory trees a worktree request may name for a project:
 *
 *  - the project's own checkout (`root.directory`), and
 *  - the managed worktree root `<dataDir>/worktree/<project_id>`, which is
 *    where `nextWorktreeInfo` actually creates worktrees — they live beside the
 *    repository, not inside it.
 *
 * Without this, `target` is whatever the caller put in `?directory=` or in the
 * JSON body, and it flows straight into `fs.rm(target, {recursive: true, force:
 * true})` (deleteWorktree) and `git -C target reset --hard` + `git clean -ffdx`
 * (resetWorktree). Neither the primary-workspace equality check nor
 * `locate()` constrains it: `locate()` returning undefined only skips the
 * `git worktree remove` step and falls through to the unconditional `fs.rm`.
 */
function withinProjectScope(project_id: string, repositoryDirectory: string, target: string) {
  return contains(path.join(dataDir(), "worktree", project_id), target)
    || contains(repositoryDirectory, target)
}

function outsideWorkspaceBody() {
  return errorBody(
    "opencode_worktree_outside_workspace",
    "directory is outside this workspace's project and worktree roots",
  )
}

export async function createWorktree(c: Context) {
  const input = workspaceInput(c)
  const ws = await resolveWorkspace({
    workspaceId: input.workspaceId,
    directory: input.directory,
  })
  if (!ws) return c.json(errorBody("opencode_workspace_not_found", "Workspace not found"), 404)
  if (ws.kind !== "local") {
    return c.json(errorBody("opencode_worktree_local_required", "Worktrees are only supported for local workspaces"), 400)
  }
  const root = await getProjectWorkspace(ws.project_id ?? ws.id)
  if (!root) return c.json(errorBody("opencode_project_workspace_not_found", "Project workspace not found"), 404)
  const body = await c.req.json().catch(() => ({})) as { name?: string; startCommand?: string }
  const info = await nextWorktreeInfo(root.directory, root.project_id ?? root.id, body.name)
  if (!info) return c.json(errorBody("opencode_worktree_name_failed", "Failed to generate a unique worktree name"), 400)
  try {
    await provisionRegisteredWorktree({
      repositoryDirectory: root.directory,
      directory: info.directory,
      workspaceName: info.name,
      checkout: { kind: "branch", branch: info.branch, noCheckout: true },
    })
  } catch (error) {
    const message = error instanceof WorktreeProvisionError ? error.detail : error instanceof Error ? error.message : String(error)
    return c.json(errorBody("opencode_worktree_create_failed", message || "Failed to create git worktree"), 400)
  }
  scheduleWorktreeReadyCheck(info, body.startCommand)
  return c.json(info)
}

export async function listWorktreeDirectories(c: Context) {
  const input = workspaceInput(c)
  const ws = await resolveWorkspace({
    workspaceId: input.workspaceId,
    directory: input.directory,
  })
  if (!ws) return c.json([])
  const project_id = ws.project_id ?? ws.id
  const root = await getProjectWorkspace(project_id)
  if (!root) return c.json([])
  const all = await listWorkspaces()
  return c.json(
    all
      .filter((item) => item.kind === "local" && item.project_id === project_id && item.directory !== root.directory)
      .map((item) => item.directory)
      .sort((a, b) => a.localeCompare(b)),
  )
}

export async function deleteWorktree(c: Context) {
  const input = workspaceInput(c)
  const target = await requestedTarget(c, input.directory)
  if (!target) return c.json(errorBody("opencode_directory_required", "directory is required"), 400)
  const ws = await resolveWorkspace({
    workspaceId: input.workspaceId,
    directory: input.directory,
  })
  if (!ws) return c.json(errorBody("opencode_workspace_not_found", "Workspace not found"), 404)
  const root = await getProjectWorkspace(ws.project_id ?? ws.id)
  if (!root) return c.json(errorBody("opencode_project_workspace_not_found", "Project workspace not found"), 404)
  if (path.resolve(target) === path.resolve(root.directory)) {
    return c.json(errorBody("opencode_primary_workspace_remove_forbidden", "Cannot remove the primary workspace"), 400)
  }
  if (!withinProjectScope(ws.project_id ?? ws.id, root.directory, target)) {
    return c.json(outsideWorkspaceBody(), 400)
  }
  const list = await gitRun(root.directory, ["worktree", "list", "--porcelain"])
  if (!list.ok) return c.json(errorBody("opencode_worktree_list_failed", list.err || list.out || "Failed to read git worktrees"), 400)
  const row = await locate(trees(list.out), target)
  const removed = row?.path
    ? await gitRun(root.directory, ["worktree", "remove", "--force", row.path])
    : { ok: true as const, out: "", err: "" }
  if (row?.path && !removed.ok) {
    const next = await gitRun(root.directory, ["worktree", "list", "--porcelain"])
    if (!next.ok) {
      return c.json(errorBody("opencode_worktree_remove_failed", removed.err || removed.out || next.err || next.out || "Failed to remove git worktree"), 400)
    }
    const stale = await locate(trees(next.out), target)
    if (stale?.path) {
      return c.json(errorBody("opencode_worktree_remove_failed", removed.err || removed.out || "Failed to remove git worktree"), 400)
    }
  }
  await fs.promises.rm(target, { recursive: true, force: true }).catch(() => undefined)
  const branch = row?.branch?.replace(/^refs\/heads\//, "")
  if (branch && branch !== "HEAD" && branch.startsWith("opencode/")) {
    const deleted = await gitRun(root.directory, ["branch", "-D", branch])
    if (!deleted.ok) {
      return c.json(errorBody("opencode_worktree_branch_delete_failed", deleted.err || deleted.out || "Failed to delete worktree branch"), 400)
    }
  }
  await deleteWorkspaceByDirectory(target)
  return c.json(true)
}

export async function resetWorktree(c: Context) {
  const input = workspaceInput(c)
  const target = await requestedTarget(c, input.directory)
  if (!target) return c.json(errorBody("opencode_directory_required", "directory is required"), 400)
  const ws = await resolveWorkspace({
    workspaceId: input.workspaceId,
    directory: input.directory,
  })
  if (!ws) return c.json(errorBody("opencode_workspace_not_found", "Workspace not found"), 404)
  const root = await getProjectWorkspace(ws.project_id ?? ws.id)
  if (!root) return c.json(errorBody("opencode_project_workspace_not_found", "Project workspace not found"), 404)
  if (path.resolve(target) === path.resolve(root.directory)) {
    return c.json(errorBody("opencode_primary_workspace_reset_forbidden", "Cannot reset the primary workspace"), 400)
  }
  if (!withinProjectScope(ws.project_id ?? ws.id, root.directory, target)) {
    return c.json(outsideWorkspaceBody(), 400)
  }
  const branch = await defaultBranch(root.directory)
  if (!branch) return c.json(errorBody("opencode_default_branch_not_found", "Default branch not found"), 400)
  if (branch.target !== branch.local) {
    const fetched = await gitRun(root.directory, ["fetch", branch.target.split("/")[0]!, branch.local])
    if (!fetched.ok) return c.json(errorBody("opencode_worktree_fetch_failed", fetched.err || fetched.out || `Failed to fetch ${branch.target}`), 400)
  }
  const reset = await gitRun(target, ["reset", "--hard", branch.target])
  if (!reset.ok) return c.json(errorBody("opencode_worktree_reset_failed", reset.err || reset.out || "Failed to reset worktree"), 400)
  const clean = await gitRun(target, ["clean", "-ffdx"])
  if (!clean.ok) return c.json(errorBody("opencode_worktree_clean_failed", clean.err || clean.out || "Failed to clean worktree"), 400)
  const update = await gitRun(target, ["submodule", "update", "--init", "--recursive", "--force"])
  if (!update.ok) return c.json(errorBody("opencode_worktree_submodule_update_failed", update.err || update.out || "Failed to update submodules"), 400)
  return c.json(true)
}

function scheduleWorktreeReadyCheck(info: WorktreeInfo, startCommand?: string) {
  setTimeout(() => {
    void (async () => {
      const reset = await gitRun(info.directory, ["reset", "--hard"])
      if (!reset.ok) {
        publishWorktreeFailed(info.directory, reset.err || reset.out || "Failed to populate worktree")
        return
      }
      publishWorktreeReady(info)
      const cmd = startCommand?.trim()
      if (!cmd) return
      const ran = await shell(info.directory, cmd)
      if (ran.ok) return
      publishWorktreeFailed(info.directory, ran.err || ran.out || "Failed to run worktree start command")
    })()
  }, 0)
}

async function requestedTarget(c: Context, directory?: string) {
  const body = await c.req.json().catch(() => ({})) as { directory?: string }
  // The frontend (and every other handler here) passes the target via the
  // `directory` query param; only fall back to the JSON body for callers
  // that send it there. Reading the body alone returned 400 for the
  // standard query-param request.
  return (directory ?? body.directory)?.trim()
}
