import "./workgraph-feature-ports"

import { For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useQuery } from "@tanstack/solid-query"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { WorkGraphContent } from "../../features/workgraph"
import { appProjectWorkGraphKey } from "../../features/workgraph/project-key"
import type { WorkGraphSessionReference } from "../../features/workgraph/api"
import { TaskComposerView } from "@/app/workbench/workgraph/task-composer-view"
import { SessionPaneScope } from "@/features/session/ui/components/session-pane-scope"
import { useClaxedoState } from "../workbench/state/index"
import { isGlobalPanelMode } from "../../features/workspaces/ui/panel/workspace-panel-state"
import { workGraphPanelBodySlot, workGraphPanelHeaderSlot } from "@/ui/controls/portal-slot"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { newTaskRoute } from "@/platform/identity/route"
import { useShellQueryOptions as useQueryOptions } from "@/app/integrations/sync/query-options"
import { useLayout } from "@/app/providers/layout"
import { workGraphExecutionContext } from "./workgraph-execution-context"
import { workGraphLocalProjectOptions } from "./workgraph-local-projects"
import { DialogSelectDirectory } from "@/app/dialogs/select-directory"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { ensureLocalProject } from "@/features/workspaces/data/query/project-ensure"
import { sessionInventoryQueryOptions } from "@/features/session/data/sync/queries"
import type { SessionInventoryRow } from "@/features/session/data/query/types"
import { openWorkGraphSession, type ContentSurfaceRenderContext } from "./first-party-content-surfaces"

export function WorkGraphSurface(props: { context: ContentSurfaceRenderContext; projectKey?: string }) {
  const platform = usePlatform()
  const state = useClaxedoState()
  const navigate = useNavigate()
  const queryOptions = useQueryOptions()
  const globalSDK = useGlobalSDK()
  const dialog = useDialog()
  const layout = useLayout()
  const projectsQuery = useQuery(() => queryOptions.projects())
  const sessionInventoryQuery = useQuery(() =>
    sessionInventoryQueryOptions<SessionInventoryRow>({ baseUrl: globalSDK.url }),
  )
  const panelState = () => state.workspacePanel.state()
  const panel = {
    mode: () => {
      const mode = panelState().mode
      if (!isGlobalPanelMode(mode)) return undefined
      if (mode === "workgraph-settings") return "settings" as const
      if (mode === "workgraph-tasks") return "tasks" as const
      return "attention" as const
    },
    isOpen: () => panelState().open,
    identity: panelState,
    open: (view: "attention" | "settings" | "tasks") =>
      state.workspacePanel.openGlobal(
        view === "settings" ? "workgraph-settings" : view === "tasks" ? "workgraph-tasks" : "workgraph-attention",
      ),
    close: () => state.workspacePanel.close(),
    headerSlot: workGraphPanelHeaderSlot,
    bodySlot: workGraphPanelBodySlot,
  }
  const directory = () => props.context.meta.directory ?? props.context.fallbackDirectory?.()
  const executionContext = () => {
    const current = directory()?.trim()
    if (!current) return undefined
    return workGraphExecutionContext(current, projectsQuery.data ?? [])
  }
  const localProjects = () => workGraphLocalProjectOptions(layout.projects.list() ?? [], projectsQuery.data ?? [])
  const chooseLocalProject = async () => {
    const result = await new Promise<string | string[] | null>((resolve) => {
      let selected = false
      dialog.show(
        () => (
          <DialogSelectDirectory
            onSelect={(directory) => {
              selected = true
              resolve(directory)
            }}
          />
        ),
        () => {
          if (!selected) resolve(null)
        },
      )
    })
    const directory = Array.isArray(result) ? result[0] : result
    if (!directory) return undefined
    await ensureLocalProject({
      baseUrl: globalSDK.url,
      request: platform.fetch,
      directory,
      projectsQuery: queryOptions.projects(),
    })
    layout.projects.open(directory)
    return directory
  }
  const openSession = (reference: WorkGraphSessionReference) =>
    openWorkGraphSession({
      reference,
      request: platform.fetch ?? fetch,
      serverUrl: globalSDK.url,
      projects: projectsQuery.data ?? [],
      inventory: sessionInventoryQuery.data,
      open: (target) => {
        state.layout.openSession(target.directory, target.sessionId, target.title, { sessionRef: target.sessionRef })
      },
      navigate,
    })
  return (
    <WorkGraphContent
      active={props.context.ctx.isVisible}
      request={platform.fetch}
      panel={panel}
      executionContext={executionContext()}
      localProjects={localProjects()}
      onChooseLocalProject={chooseLocalProject}
      onOpenSession={openSession}
      projectKey={props.projectKey}
    />
  )
}

export function WorkspaceWorkGraphSurface(props: { context: ContentSurfaceRenderContext }) {
  const queryOptions = useQueryOptions()
  const projectsQuery = useQuery(() => queryOptions.projects())
  const directory = props.context.meta.directory
  const projectKey = () => {
    if (!directory) return undefined
    const execution = workGraphExecutionContext(directory, projectsQuery.data ?? [])
    if (execution?.kind === "hosted_workspace") return `hosted:${execution.repositoryUrl}`
    const project = (projectsQuery.data ?? []).find((candidate) => candidate.worktree === directory)
    return appProjectWorkGraphKey(project ?? { worktree: directory }, directory)
  }
  return <WorkGraphSurface context={props.context} projectKey={projectKey()} />
}

export function TaskComposerSurface(props: { context: ContentSurfaceRenderContext }) {
  const platform = usePlatform()
  const state = useClaxedoState()
  const navigate = useNavigate()
  const queryOptions = useQueryOptions()
  const projectsQuery = useQuery(() => queryOptions.projects())
  const retarget = (nextDirectory: string) => {
    state.meta.patch(props.context.meta.id, {
      directory: nextDirectory,
      scope: "directory",
      content: { type: "task-composer", directory: nextDirectory, title: "New task" },
    })
    navigate(newTaskRoute(nextDirectory), { replace: true })
  }
  return (
    <Show
      keyed
      when={props.context.meta.directory}
      fallback={
        <main
          class="flex size-full items-center justify-center bg-background-base p-6"
          aria-label="Choose a project for the task"
        >
          <section class="w-full max-w-md rounded-xl border border-border-weak-base bg-surface-raised-base p-4 shadow-sm">
            <h1 class="text-[14px] font-medium text-text-base">Where should this task live?</h1>
            <p class="mt-1 text-[12px] text-text-weaker">Choose a project before composing the task.</p>
            <div class="mt-3 space-y-1">
              <For each={projectsQuery.data ?? []}>
                {(project) => (
                  <button
                    type="button"
                    class="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-[12px] text-text-base hover:bg-surface-base-hover"
                    onClick={() => retarget(project.worktree)}
                  >
                    <span class="truncate">
                      {project.name?.trim() || project.worktree.split("/").filter(Boolean).at(-1)}
                    </span>
                    <span class="ml-3 truncate text-[11px] text-text-weaker">{project.worktree}</span>
                  </button>
                )}
              </For>
            </div>
          </section>
        </main>
      }
    >
      {(directory) => (
        <SessionPaneScope
          directory={directory}
          active={props.context.ctx.isVisible}
          paneId={() => props.context.ctx.paneId}
          surfaceId={() => props.context.meta.id}
        >
          <TaskComposerView directory={directory} request={platform.fetch} onRetarget={retarget} />
        </SessionPaneScope>
      )}
    </Show>
  )
}
