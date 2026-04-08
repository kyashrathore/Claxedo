import { getFilename } from "@opencode-ai/util/path"
import { showToast } from "@opencode-ai/ui/toast"
import { DialogRecoverWorkspace } from "../components/dialogs"
import type { ProjectItem } from "../layouts/rail-sidebar"
import type { WorkspaceBarItem } from "../layouts/top-tab-bar"
import type { ActionProps } from "./shared"
import { findProjectForWorkspace, message, missingLocalWorkspace } from "./shared"

export async function createLocalWorkspace(
  props: ActionProps,
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

    const [child] = props.globalSync.child(created)
    props.claxedo.workspaceRecency.recordAccess(project.id, created)
    props.claxedo.worktree.setPinned(null)
    props.claxedo.worktree.setDefault(created)

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
        return
      }
    }

    if (child.status === "loading") {
      await new Promise<void>((resolve) => {
        const id = setInterval(() => {
          if (child.status === "loading") return
          clearInterval(id)
          resolve()
        }, 100)
      })
    }

    input.onProgress?.("ready")
    await input.onReady?.(created, item)
    return item
  } catch (err) {
    input.onProgress?.("error", err instanceof Error ? err.message : "Failed to create worktree")
    showToast({ title: "Failed to create worktree", description: message(err), variant: "error" })
  }
}

export function recoverMissingWorkspace(
  props: ActionProps,
  workspaceDir: string,
  onReady: (created: string, project: ProjectItem, item: WorkspaceBarItem) => void | Promise<void>,
) {
  const ws = missingLocalWorkspace(props.projects, workspaceDir)
  if (!ws) return false
  const project = findProjectForWorkspace(props.projects, workspaceDir)
  if (!project) return false

  props.dialog.show(() => (
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
