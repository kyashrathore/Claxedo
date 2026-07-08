import { getFilename } from "@claxedo/utils/path"
import { showToast } from "@opencode-ai/ui/toast"
import { DialogRecoverWorkspace } from "../components/dialogs"
import type { ProjectItem } from "../layouts/rail-sidebar"
import type { WorkspaceBarItem } from "../layouts/workspace-toolbar"
import type { ActionProps } from "./shared"
import { ensureDirectorySessionCache, findProjectForWorkspace, message, missingLocalWorkspace } from "./shared"

type WorkspaceDirectoryRef = string

export type LocalWorkspaceProps = Pick<ActionProps, "directorySessionCacheActions" | "dialog" | "events" | "flowLog" | "projects"> & {
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

    props.state.workspace.recordAccess(project.id, created)
    const paneId = props.state.wb.state.focusedPaneId
    if (paneId) {
      props.state.workspace.setPaneWorktreePinned(paneId, null)
      props.state.workspace.setPaneWorktreeDefault(paneId, created)
    }

    if (props.events) {
      const wait = await new Promise<{ status: "ready" | "failed"; message?: string }>((resolve) => {
        const ok = props.events!.on("worktree.ready", (event) => {
          if (event.directory !== created) return
          ok()
          fail()
          resolve({ status: "ready" })
        })
        const fail = props.events!.on("worktree.failed", (event) => {
          if (event.directory !== created) return
          ok()
          fail()
          resolve({ status: "failed", message: event.message })
        })
        setTimeout(() => { ok(); fail(); resolve({ status: "ready" }) }, 60_000)
      })
      if (wait.status === "failed") {
        input.onProgress?.("error", wait.message)
        showToast({ title: "Failed to create worktree", description: wait.message ?? "Unknown error", variant: "error" })
        return undefined
      }
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
        await createLocalWorkspace(props, project, {
          onReady: async (created, item) => onReady(created, project, item),
        })
      }}
      onClose={() => props.dialog.close()}
    />
  ))
  return true
}
