import path from "node:path"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { deleteWorkspaceByDirectory, ensureWorkspace } from "./store"
import { gitRun } from "../opencode/compat-routes/git"

export type RegisteredWorktreeProvision = Readonly<{
  repositoryDirectory: string
  directory: string
  workspaceName: string
  workspaceId?: string
  checkout:
    | Readonly<{ kind: "detached"; revision: string }>
    | Readonly<{ kind: "branch"; branch: string; noCheckout?: boolean }>
}>

export class WorktreeProvisionError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message)
  }
}

export function workGraphWorkspaceId(directory: string) {
  return `workgraph_${createHash("sha256").update(path.resolve(directory)).digest("hex").slice(0, 32)}`
}

export async function provisionRegisteredWorktree(input: RegisteredWorktreeProvision) {
  const project = await ensureWorkspace({ directory: input.repositoryDirectory })
  if (!project || project.kind !== "local") {
    throw new WorktreeProvisionError("Project workspace not found", input.repositoryDirectory)
  }
  const present = await fs.stat(path.join(input.directory, ".git")).then(() => true, () => false)
  if (!present) {
    await fs.mkdir(path.dirname(input.directory), { recursive: true })
    const args = input.checkout.kind === "detached"
      ? ["worktree", "add", "--detach", input.directory, input.checkout.revision]
      : [
          "worktree",
          "add",
          ...(input.checkout.noCheckout ? ["--no-checkout"] : []),
          "-b",
          input.checkout.branch,
          input.directory,
        ]
    const created = await gitRun(project.directory, args)
    if (!created.ok) {
      throw new WorktreeProvisionError("Failed to create git worktree", created.err || created.out)
    }
  }
  const workspace = await ensureWorkspace({
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    project_id: project.project_id ?? project.id,
    project_name: project.project_name,
    workspace_name: input.workspaceName,
    directory: input.directory,
  })
  if (workspace) return workspace
  if (!present) await removeGitWorktree(input.directory).catch(() => undefined)
  throw new WorktreeProvisionError("Failed to register git worktree", input.directory)
}

export async function releaseRegisteredWorktree(directory: string) {
  await removeGitWorktree(directory)
  await deleteWorkspaceByDirectory(directory)
}

async function removeGitWorktree(directory: string) {
  if (!(await fs.stat(directory).then(() => true, () => false))) return
  const common = await gitRun(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  if (!common.ok) throw new WorktreeProvisionError("Failed to locate git worktree", common.err || common.out)
  const removed = await gitRun(directory, ["--git-dir", common.out, "worktree", "remove", "--force", directory])
  if (!removed.ok) throw new WorktreeProvisionError("Failed to remove git worktree", removed.err || removed.out)
}
