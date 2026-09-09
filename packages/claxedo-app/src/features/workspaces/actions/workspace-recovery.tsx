import { resolveWorkspaceRuntime } from "@/platform/runtime/workspace-runtime-record"
import { refreshProjectInventory } from "../data/query/project-ensure"
import { Worktree } from "@/platform/sync/worktree"
import { getFilename } from "@opencode-ai/ui/utils/path"
import { showToast } from "@opencode-ai/ui/toast"
import { DialogRecoverWorkspace, ensureDirectorySessionCache, findProjectForWorkspace, message, missingLocalWorkspace } from "@/features/workspaces/app-ports"
import type { ProjectItem } from "../../../app/workbench/rail/domain-types"
import type { WorkspaceBarItem } from "../../../app/workbench/rail/workspace-toolbar"
import type { ActionProps } from "../../../app/workbench/actions/shared"

type WorkspaceDirectoryRef = string

export type LocalWorkspaceProps = Pick<ActionProps, "directorySessionCacheActions" | "dialog" | "flowLog" | "projects" | "projectInventoryActions"> & {
  platform: Pick<ActionProps["platform"], "fetch">
  state: {
    wb: {
      state: Pick<ActionProps["state"]["wb"]["state"], "focusedPaneId">
    }
    workspace: Pick<
      ActionProps["state"]["workspace"],
      "setPaneWorktreePinned" | "setPaneWorktreeDefault" | "recordAccess"
    >
  }
  globalSDK: {
    url?: string
    client: {
      worktree: {
        create: (input: { directory: WorkspaceDirectoryRef; worktreeCreateInput: { name?: string } }) => Promise<{
          data?: {
            directory?: WorkspaceDirectoryRef
            name?: string | null
          }
        }>
      }
    }
  }
}

export async function createLocalWorkspace(
  props: LocalWorkspaceProps,
  project: ProjectItem,
  input: {
    onProgress?: (step: string, message?: string) => void
    workspaceName?: string
    onReady?: (created: string, item: WorkspaceBarItem) => void | Promise<void>
  },
): Promise<WorkspaceBarItem | undefined> {
  try {
    input.onProgress?.("creating")
    const result = await props.globalSDK.client.worktree.create({
      directory: project.worktree,
      worktreeCreateInput: { name: input.workspaceName },
    })
    const created = result.data?.directory
    const name = result.data?.name
    if (!created) throw new Error("Worktree create did not return a directory")

    props.flowLog("workspace created", {
      projectId: project.id,
      created,
      name,
    })

    const item = {
      id: created,
      directory: created,
      name: name ?? getFilename(created),
      projectWorktree: project.worktree,
      canDelete: true,
      available: true,
    } satisfies WorkspaceBarItem

    const wait = await Worktree.wait(created)
    if (wait.status === "failed") {
      input.onProgress?.("error", wait.message)
      showToast({ title: "Failed to create worktree", description: wait.message, variant: "error" })
      return undefined
    }

    props.state.workspace.recordAccess(project.id, created)
    const paneId = props.state.wb.state.focusedPaneId
    if (paneId) {
      props.state.workspace.setPaneWorktreePinned(paneId, null)
      props.state.workspace.setPaneWorktreeDefault(paneId, created)
    }

    await ensureDirectorySessionCache(props.directorySessionCacheActions, created)

    input.onProgress?.("ready")
    await input.onReady?.(created, item)
    return item
  } catch (err) {
    input.onProgress?.("error", err instanceof Error ? err.message : "Failed to create worktree")
    showToast({ title: "Failed to create worktree", description: message(err), variant: "error" })
    return undefined
  }
}

export function recoverMissingWorkspace(
  props: LocalWorkspaceProps,
  workspaceDir: string,
  onReady: (created: string, project: ProjectItem, item: WorkspaceBarItem) => void | Promise<void>,
) {
  const ws = missingLocalWorkspace(props.projects, workspaceDir)
  if (!ws) return false
  const project = findProjectForWorkspace(props.projects, workspaceDir)
  if (!project) return false

  void props.dialog.show(() => (
    <DialogRecoverWorkspace
      name={ws.name ?? getFilename(workspaceDir)}
      onRecover={async () => {
        const recovered = await createLocalWorkspace(props, project, {
          onReady: async (created, item) => {
            const workspace = await resolveWorkspaceRuntime({ baseUrl: props.globalSDK.url, request: props.platform.fetch, directory: created })
            if (!workspace) throw new Error("The new workspace is unavailable")
            await refreshProjectInventory(props.projectInventoryActions.query())
            await onReady(created, project, { ...item, workspaceId: workspace.workspaceId })
          },
        })
        return !!recovered
      }}
      onClose={() => props.dialog.close()}
    />
  ))
  return true
}
