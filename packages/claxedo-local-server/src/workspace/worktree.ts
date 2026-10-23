import { ensureWorkspace } from "@claxedo/server-core/workspace/store/index"
import { addGitWorktree, removeGitWorktree, resolveWorktreeCheckout, WorktreeProvisionError, type WorktreeCheckout } from "@claxedo/server-core/hosts/machine/worktree"

export type RegisteredWorktreeProvision = Readonly<{
  repositoryDirectory: string
  directory: string
  workspaceName: string
  workspaceId?: string
  checkout: WorktreeCheckout
}>

/** A git worktree of a registered project, registered as a workspace of that project; taken back if it cannot be. */
export async function provisionRegisteredWorktree(input: RegisteredWorktreeProvision) {
  const checkout = await resolveWorktreeCheckout(input.repositoryDirectory, input.checkout)
  const project = await ensureWorkspace({ directory: input.repositoryDirectory })
  if (!project || project.kind !== "local") {
    throw new WorktreeProvisionError("Project workspace not found", input.repositoryDirectory)
  }
  const { created } = await addGitWorktree(project.directory, input.directory, checkout)
  const workspace = await ensureWorkspace({
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    project_id: project.project_id ?? project.id,
    project_name: project.project_name,
    workspace_name: input.workspaceName,
    directory: input.directory,
  })
  if (workspace) return workspace
  if (created) await removeGitWorktree(input.directory).catch(() => undefined)
  throw new WorktreeProvisionError("Failed to register git worktree", input.directory)
}
