import type { Context } from "hono"
import path from "path"
import { deleteWorkspaceByDirectory, getProjectWorkspace, listWorkspaces, resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { errorBody } from "@claxedo/server-core/platform/http/http"
import { workspaceInput } from "./request-context"
import { containsCanonical, defaultBranch, gitRun, locate, shell, trees } from "./git"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { nextWorktreeInfo, publishWorktreeFailed, publishWorktreeReady } from "./worktree"
import { provisionRegisteredWorktree, WorktreeProvisionError } from "../workspace/worktree"
import { raw, record, trimmed } from "../platform/json"

type WorktreeInfo = NonNullable<Awaited<ReturnType<typeof nextWorktreeInfo>>>

/** The project checkout and its managed worktree root bound the registry lookup below. */
async function withinProjectScope(project_id: string, repositoryDirectory: string, target: string) {
  const [managed, repository] = await Promise.all([
    containsCanonical(path.join(dataDir(), "worktree", project_id), target),
    containsCanonical(repositoryDirectory, target),
  ])
  return managed || repository
}

function outsideWorkspaceBody() {
  return errorBody(
    "claxedo_worktree_outside_workspace",
    "directory is outside this workspace's project and worktree roots",
  )
}

/** Destructive operations require both an application registration and an exact Git worktree entry. */
async function registeredWorktree(projectId: string, rootDirectory: string, target: string) {
  const workspaces = await listWorkspaces()
  const registered = await locate(workspaces
    .filter((workspace) => workspace.kind === "local" && workspace.project_id === projectId)
    .map((workspace) => ({ path: workspace.directory })), target)
  if (!registered) return { ok: false as const, body: errorBody("claxedo_worktree_not_found", "Registered worktree not found") }
  const list = await gitRun(rootDirectory, ["worktree", "list", "--porcelain"])
  if (!list.ok) return { ok: false as const, body: errorBody("claxedo_worktree_list_failed", list.err || list.out || "Failed to read git worktrees") }
  const row = await locate(trees(list.out), target)
  if (!row?.path) return { ok: false as const, body: errorBody("claxedo_worktree_not_found", "Registered worktree not found") }
  return { ok: true as const, path: row.path, branch: row.branch }
}

export async function createWorktree(c: Context) {
  const input = workspaceInput(c)
  const ws = await resolveWorkspace({
    workspaceId: input.workspaceId,
    directory: input.directory,
  })
  if (!ws) return c.json(errorBody("claxedo_workspace_not_found", "Workspace not found"), 404)
  if (ws.kind !== "local") {
    return c.json(errorBody("claxedo_worktree_local_required", "Worktrees are only supported for local workspaces"), 400)
  }
  const root = await getProjectWorkspace(ws.project_id ?? ws.id)
  if (!root) return c.json(errorBody("claxedo_project_workspace_not_found", "Project workspace not found"), 404)
  const body = record(await c.req.json().catch(() => ({}))) ?? {}
  const info = await nextWorktreeInfo(root.directory, root.project_id ?? root.id, trimmed(body.name))
  if (!info) return c.json(errorBody("claxedo_worktree_name_failed", "Failed to generate a unique worktree name"), 400)
  try {
    const workspace = await provisionRegisteredWorktree({
      repositoryDirectory: root.directory,
      directory: info.directory,
      workspaceName: info.name,
      checkout: { kind: "branch", branch: info.branch, noCheckout: true },
    })
    const registeredInfo = { ...info, directory: workspace.directory }
    scheduleWorktreeReadyCheck(registeredInfo, raw(body.startCommand))
    return c.json(registeredInfo)
  } catch (error) {
    const message = error instanceof WorktreeProvisionError ? error.detail : error instanceof Error ? error.message : String(error)
    return c.json(errorBody("claxedo_worktree_create_failed", message || "Failed to create git worktree"), 400)
  }
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
  if (!target) return c.json(errorBody("claxedo_directory_required", "directory is required"), 400)
  const ws = await resolveWorkspace({
    workspaceId: input.workspaceId,
    directory: input.directory,
  })
  if (!ws) return c.json(errorBody("claxedo_workspace_not_found", "Workspace not found"), 404)
  const root = await getProjectWorkspace(ws.project_id ?? ws.id)
  if (!root) return c.json(errorBody("claxedo_project_workspace_not_found", "Project workspace not found"), 404)
  if (await locate([{ path: root.directory }], target)) {
    return c.json(errorBody("claxedo_primary_workspace_remove_forbidden", "Cannot remove the primary workspace"), 400)
  }
  if (!(await withinProjectScope(ws.project_id ?? ws.id, root.directory, target))) {
    return c.json(outsideWorkspaceBody(), 400)
  }
  const row = await registeredWorktree(ws.project_id ?? ws.id, root.directory, target)
  if (!row.ok) return c.json(row.body, 400)
  const removed = await gitRun(root.directory, ["worktree", "remove", "--force", row.path])
  if (!removed.ok) return c.json(errorBody("claxedo_worktree_remove_failed", removed.err || removed.out || "Failed to remove git worktree"), 400)
  const branch = row?.branch?.replace(/^refs\/heads\//, "")
  if (branch && branch !== "HEAD" && branch.startsWith("claxedo/")) {
    const deleted = await gitRun(root.directory, ["branch", "-D", branch])
    if (!deleted.ok) {
      return c.json(errorBody("claxedo_worktree_branch_delete_failed", deleted.err || deleted.out || "Failed to delete worktree branch"), 400)
    }
  }
  await deleteWorkspaceByDirectory(row.path)
  return c.json(true)
}

export async function resetWorktree(c: Context) {
  const input = workspaceInput(c)
  const target = await requestedTarget(c, input.directory)
  if (!target) return c.json(errorBody("claxedo_directory_required", "directory is required"), 400)
  const ws = await resolveWorkspace({
    workspaceId: input.workspaceId,
    directory: input.directory,
  })
  if (!ws) return c.json(errorBody("claxedo_workspace_not_found", "Workspace not found"), 404)
  const root = await getProjectWorkspace(ws.project_id ?? ws.id)
  if (!root) return c.json(errorBody("claxedo_project_workspace_not_found", "Project workspace not found"), 404)
  if (await locate([{ path: root.directory }], target)) {
    return c.json(errorBody("claxedo_primary_workspace_reset_forbidden", "Cannot reset the primary workspace"), 400)
  }
  if (!(await withinProjectScope(ws.project_id ?? ws.id, root.directory, target))) {
    return c.json(outsideWorkspaceBody(), 400)
  }
  const row = await registeredWorktree(ws.project_id ?? ws.id, root.directory, target)
  if (!row.ok) return c.json(row.body, 400)
  const branch = await defaultBranch(root.directory)
  if (!branch) return c.json(errorBody("claxedo_default_branch_not_found", "Default branch not found"), 400)
  if (branch.target !== branch.local) {
    const fetched = await gitRun(root.directory, ["fetch", branch.target.split("/")[0], branch.local])
    if (!fetched.ok) return c.json(errorBody("claxedo_worktree_fetch_failed", fetched.err || fetched.out || `Failed to fetch ${branch.target}`), 400)
  }
  const reset = await gitRun(row.path, ["reset", "--hard", branch.target])
  if (!reset.ok) return c.json(errorBody("claxedo_worktree_reset_failed", reset.err || reset.out || "Failed to reset worktree"), 400)
  const clean = await gitRun(row.path, ["clean", "-ffdx"])
  if (!clean.ok) return c.json(errorBody("claxedo_worktree_clean_failed", clean.err || clean.out || "Failed to clean worktree"), 400)
  const update = await gitRun(row.path, ["submodule", "update", "--init", "--recursive", "--force"])
  if (!update.ok) return c.json(errorBody("claxedo_worktree_submodule_update_failed", update.err || update.out || "Failed to update submodules"), 400)
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
  const body = record(await c.req.json().catch(() => ({}))) ?? {}
  // The frontend (and every other handler here) passes the target via the
  // `directory` query param; only fall back to the JSON body for callers
  // that send it there. Reading the body alone returned 400 for the
  // standard query-param request.
  return (directory ?? raw(body.directory))?.trim()
}
