import { useGlobalSDK, useGlobalSync } from "@opencode-ai/claxedo-app"
import { Select } from "@opencode-ai/ui/select"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { For, Show, createEffect, createMemo } from "solid-js"
import { useComments } from "@/context/comments"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { useConfigOptional } from "../../context/config"
import { useClaxedoEventsOptional } from "../../providers/claxedo-events"
import { api, getDefaultBaseUrl } from "../../utils/api"
import { getFilename } from "@opencode-ai/util/path"
import { useClaxedoState } from "../state"
import { CompactPromptDock } from "./compact-prompt-dock"
import { WorkspaceAttachBrowser } from "./workspace-attach-browser"
import type { WorkspaceAttachItem } from "./workspace-attach-browser"
import { WorkspaceCreateFlow } from "./workspace-create-flow"
import {
  projectDisplayName,
  projectWorkspaceDirectories,
  workspaceDisplayName,
  workspaceIsCloud,
  type WorkspaceDisplayProject,
} from "../utils/workspace-display"

type CreateWorkspaceResult = {
  workspaceId: string
  directory?: string
}

type DraftProjectSource = WorkspaceDisplayProject

type DraftProjectOption = {
  id: string
  directory: string
  name: string
}

type DraftWorkspace = WorkspaceAttachItem

function draftSessionAttachmentState(directory?: string) {
  return directory ? "attached" : "unattached"
}

function draftSessionBadgeLabel(directory?: string) {
  return draftSessionAttachmentState(directory) === "attached" ? "Attached" : "Unattached"
}

function draftSessionTitle(input: { directory?: string; workspaceName?: string }) {
  const workspace = input.workspaceName ?? (input.directory ? getFilename(input.directory) : undefined)
  if (!workspace) return "Draft"
  return `Draft: ${workspace}`
}

function projectName(project: DraftProjectSource) {
  return projectDisplayName(project)
}

function flattenWorkspaces(projects: DraftProjectSource[]): DraftWorkspace[] {
  return projects.flatMap((project) => {
    return projectWorkspaceDirectories(project).map((directory) => ({
      id: directory,
      directory,
      projectId: project.id,
      projectName: projectName(project),
      name: workspaceDisplayName(project, directory),
      isMain: directory === project.worktree,
      isCloud: workspaceIsCloud(project, directory),
    }))
  })
}

function projectOptions(projects: DraftProjectSource[]): DraftProjectOption[] {
  return projects.map((project) => ({
    id: project.id,
    directory: project.worktree,
    name: projectName(project),
  }))
}

function findProjectForDirectory(projects: DraftProjectSource[], directory?: string) {
  if (!directory) return
  return projects.find(
    (project) =>
      project.worktree === directory ||
      (project.sandboxes ?? []).includes(directory) ||
      directory in (project.workspaces ?? {}),
  )
}

function preferredProjectId(
  projects: DraftProjectSource[],
  input: { directory?: string; providerDirectory?: string; selectedProjectId?: string },
) {
  if (input.selectedProjectId && projects.some((project) => project.id === input.selectedProjectId)) {
    return input.selectedProjectId
  }
  const attached = findProjectForDirectory(projects, input.directory)
  if (attached) return attached.id
  const provider = findProjectForDirectory(projects, input.providerDirectory)
  if (provider) return provider.id
  return projects[0]?.id
}

export function DraftSessionPane(props: {
  surfaceId: string
  leafId: string
  draftId: string
  providerDirectory: string
  directory?: string
}) {
  const state = useClaxedoState()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const prompt = usePrompt()
  const comments = useComments()
  const config = useConfigOptional()
  const events = useClaxedoEventsOptional()

  const projects = createMemo(() => (globalSync.data.project ?? []) as DraftProjectSource[])
  const draftTab = createMemo(() => state.meta.get(props.surfaceId))
  const workspaces = createMemo(() => flattenWorkspaces(projects()))
  const projectChoices = createMemo(() => projectOptions(projects()))
  const current = createMemo(() => workspaces().find((item) => item.directory === props.directory))
  const status = createMemo(() => draftSessionAttachmentState(props.directory))
  const statusLabel = createMemo(() => draftSessionBadgeLabel(props.directory))
  const selectedProjectId = createMemo(() => draftTab()?.draftProjectId)
  const draftPanel = createMemo(() => draftTab()?.draftPanel)
  const showAttach = createMemo(() => draftPanel() === "attach")
  const showCreate = createMemo(() => draftPanel() === "create")
  const title = createMemo(() => draftSessionTitle({ directory: props.directory, workspaceName: current()?.name }))
  const selectedProjectChoice = createMemo(() => projectChoices().find((item) => item.id === selectedProjectId()))
  const selectedProject = createMemo(() => projects().find((item) => item.id === selectedProjectId()))
  const canCreateCloud = createMemo(() => !!config?.sandboxEnabled)

  const patchDraftTab = (patch: Record<string, unknown>) => {
    state.meta.patch(props.surfaceId, patch)
  }

  createEffect(() => {
    const next = preferredProjectId(projects(), {
      directory: props.directory,
      providerDirectory: props.providerDirectory,
      selectedProjectId: selectedProjectId(),
    })
    if (next && next !== selectedProjectId()) patchDraftTab({ draftProjectId: next })
  })

  const setDirectory = (directory?: string) => {
    const workspace = workspaces().find((item) => item.directory === directory)
    const nextTitle = draftSessionTitle({ directory, workspaceName: workspace?.name })
    patchDraftTab({
      directory,
      title: nextTitle,
      draftPanel: undefined,
      ...(workspace?.projectId ? { draftProjectId: workspace.projectId } : {}),
    })
    state.meta.patch(props.surfaceId, {
      directory,
      content: {
        type: "draft-session",
        title: nextTitle,
        draftId: props.draftId,
        providerDirectory: props.providerDirectory,
        ...(directory ? { directory } : {}),
      },
    })
  }

  createEffect(() => {
    const nextTitle = title()
    const content = state.meta.get(props.surfaceId)?.content
    if (content?.type === "draft-session" && content.title === nextTitle && content.directory === props.directory) return
    state.meta.patch(props.surfaceId, {
      content: {
        type: "draft-session",
        title: nextTitle,
        draftId: props.draftId,
        providerDirectory: props.providerDirectory,
        ...(props.directory ? { directory: props.directory } : {}),
      },
    })
  })

  const resetCreateState = () => {
    patchDraftTab({ draftPanel: undefined })
  }

  const openCreateForProject = (projectId?: string) => {
    patchDraftTab({
      draftPanel: "create",
      ...(projectId ? { draftProjectId: projectId } : {}),
    })
  }

  const attachCreatedWorkspace = async (project: DraftProjectSource, directory: string) => {
    await globalSync.bootstrap().catch(() => undefined)
    globalSync.child(directory)
    state.workspace.recordAccess(project.id, directory)
    const paneId = state.wb.state.focusedPaneId
    if (paneId) {
      state.workspace.setPaneWorktreePinned(paneId, null)
      state.workspace.setPaneWorktreeDefault(paneId, directory)
    }
    setDirectory(directory)
    resetCreateState()
  }

  const waitForLocalWorktree = (
    directory: string,
    onProgress?: (step: string, message?: string) => void,
  ) =>
    new Promise<void>((resolve, reject) => {
      if (!events) {
        resolve()
        return
      }
      const ready = events.on("worktree.ready", (event) => {
        if (event.directory !== directory) return
        ready()
        failed()
        onProgress?.("ready", event.name ? `Workspace ready: ${event.name}` : undefined)
        resolve()
      })
      const failed = events.on("worktree.failed", (event) => {
        if (event.directory !== directory) return
        ready()
        failed()
        reject(new Error(event.message || "Failed to create worktree"))
      })
      setTimeout(() => {
        ready()
        failed()
        resolve()
      }, 60_000)
    })

  const waitForCloudWorkspace = (
    workspaceId: string,
    onProgress?: (step: string, message?: string) => void,
  ) =>
    new Promise<void>((resolve, reject) => {
      if (!events) {
        resolve()
        return
      }
      const unsub = events.on("provision", (event) => {
        if (event.workspaceId !== workspaceId) return
        onProgress?.(event.step, event.message)
        if (event.step === "ready") {
          unsub()
          resolve()
          return
        }
        if (event.step === "error") {
          unsub()
          reject(new Error(event.message || "Failed to create cloud workspace"))
        }
      })
      setTimeout(() => {
        unsub()
        resolve()
      }, 120_000)
    })

  const createLocalWorkspace = async (
    project: DraftProjectSource,
    onProgress?: (step: string, message?: string) => void,
    name?: string,
  ) => {
    onProgress?.("creating")
    const result = await globalSDK.client.worktree.create({
      directory: project.worktree,
      worktreeCreateInput: { ...(name ? { name } : {}) },
    })
    const directory = result.data?.directory
    if (!directory) throw new Error("Worktree create did not return a directory")
    await waitForLocalWorktree(directory, onProgress)
    onProgress?.("redirecting")
    await attachCreatedWorkspace(project, directory)
  }

  const createCloudWorkspace = async (
    project: DraftProjectSource,
    onProgress?: (step: string, message?: string) => void,
    name?: string,
  ) => {
    onProgress?.("acquiring_sandbox")
    const result = await api.post<CreateWorkspaceResult>(`${getDefaultBaseUrl()}/api/workspace/create`, {
      projectId: project.id,
      ...(name ? { workspaceName: name } : {}),
    })
    const directory = result.directory
    if (!directory) throw new Error("Workspace create did not return a directory")
    await waitForCloudWorkspace(result.workspaceId, onProgress)
    onProgress?.("redirecting")
    await attachCreatedWorkspace(project, directory)
  }

  return (
    <div class="flex size-full flex-col bg-background-base">
      <div class="border-b border-border-weak-base px-4 py-3">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <div class="text-14-medium text-text-base">Draft composer</div>
              <span
                class="inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none"
                classList={{
                  "border-border-weak-base bg-surface-base-hover/60 text-text-weaker": status() === "unattached",
                  "border-border-success-base/20 bg-surface-success-base/10 text-text-on-success-base": status() === "attached",
                }}
              >
                {statusLabel()}
              </span>
            </div>
            <div class="mt-1 text-12-regular text-text-weak">
              <Show
                when={current()}
                fallback="Attach a workspace to enable send and turn this draft into a real session."
              >
                {(workspace) => `Ready to send in ${workspace().projectName} / ${workspace().name}.`}
              </Show>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <Select
              size="normal"
              options={workspaces()}
              current={current()}
              value={(item) => item.directory}
              label={(item) => `${item.projectName} / ${item.name}`}
              groupBy={(item) => item.projectName}
              onSelect={(item) => setDirectory(item?.directory)}
              placeholder="Attach workspace"
              class="max-w-[260px]"
              valueClass="truncate text-13-regular"
              variant="ghost"
            />
            <Button
              size="normal"
              variant="secondary"
              onClick={() => {
                if (showAttach()) {
                  patchDraftTab({ draftPanel: undefined })
                  return
                }
                patchDraftTab({ draftPanel: "attach" })
              }}
            >
              {showAttach() ? "Hide attach" : props.directory ? "Switch workspace" : "Attach workspace"}
            </Button>
            <Button
              size="normal"
              variant="secondary"
              onClick={() => {
                if (showCreate()) {
                  resetCreateState()
                  return
                }
                patchDraftTab({ draftPanel: "create" })
              }}
            >
              {showCreate() ? "Hide create" : "Create workspace"}
            </Button>
            <Show when={props.directory}>
              <Button size="normal" variant="ghost" onClick={() => setDirectory(undefined)}>
                Detach
              </Button>
            </Show>
          </div>
        </div>
        <Show when={current()}>
          {(workspace) => (
            <div class="mt-3 flex items-center gap-2 text-12-regular text-text-weak">
              <Icon name="check-small" size="small" class="shrink-0 text-icon-success-base" />
              <span class="truncate">
                Attached to {workspace().projectName} / {workspace().name}
              </span>
            </div>
          )}
        </Show>
        <Show when={showAttach()}>
          <div class="mt-3 overflow-hidden rounded-lg border border-border-weak-base/50 bg-surface-base-hover/20">
            <WorkspaceAttachBrowser
              projects={projects().map((project) => ({
                id: project.id,
                name: projectName(project),
                worktree: project.worktree,
              }))}
              items={workspaces()}
              currentDirectory={props.directory}
              onSelect={(_projectId, directory) => {
                setDirectory(directory)
              }}
              onCreateProject={(projectId) => openCreateForProject(projectId)}
            />
          </div>
        </Show>
        <Show when={showCreate()}>
          <div class="mt-3 rounded-lg border border-border-weak-base/50 bg-surface-base-hover/20 p-3">
            <div class="flex flex-col gap-1">
              <div class="text-12-medium text-text-base">Create and attach a new workspace</div>
              <div class="text-[11px] text-text-weaker">
                Keep drafting here, then bind this composer to a fresh local worktree or cloud workspace.
              </div>
            </div>

            <div class="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
              <Select
                size="normal"
                options={projectChoices()}
                current={selectedProjectChoice()}
                value={(item) => item.id}
                label={(item) => item.name}
                onSelect={(item) => patchDraftTab({ draftProjectId: item?.id })}
                placeholder="Choose project"
                class="min-w-0"
                valueClass="truncate text-13-regular"
                variant="secondary"
              />
            </div>
            <Show when={selectedProject()}>
              {(project) => (
                <div class="mt-3 overflow-hidden rounded-md border border-border-weak-base/50">
                  <WorkspaceCreateFlow
                    project={{
                      id: project().id,
                      name: projectName(project()),
                      worktree: project().worktree,
                    }}
                    projectName={selectedProjectChoice()?.name ?? projectName(project())}
                    canCreateCloud={canCreateCloud()}
                    initialType="local"
                    onComplete={resetCreateState}
                    onCreateLocal={(entry, onProgress, name) =>
                      createLocalWorkspace(project(), onProgress, name)
                    }
                    onCreateCloud={(entry, onProgress, name) =>
                      createCloudWorkspace(project(), onProgress, name)
                    }
                  />
                </div>
              )}
            </Show>
            <Show when={!selectedProject()}>
              <div class="mt-3 text-[11px] text-text-weaker">Choose a project to create in.</div>
            </Show>
          </div>
        </Show>
      </div>

      <div class="min-h-0 flex-1 p-4">
        <div class="mb-3 rounded-lg border border-border-weak-base/50 bg-surface-base-hover/20 px-3 py-2 text-12-regular text-text-weak">
          <Show
            when={current()}
            fallback="Send is waiting on a workspace attachment. You can attach an existing workspace or create a new one from this draft."
          >
            {(workspace) => `First send will create the session in ${workspace().projectName} / ${workspace().name}.`}
          </Show>
        </div>
        <CompactPromptDock
          title={title()}
          t={language.t as (key: string, vars?: Record<string, string | number | boolean>) => string}
          questionRequest={() => undefined}
          permissionRequest={() => undefined}
          blocked={false}
          todos={[]}
          promptReady={prompt.ready()}
          handoffPrompt={undefined}
          responding={false}
          onDecide={() => undefined}
          inputRef={() => undefined}
          newSessionWorktree="main"
          onNewSessionWorktreeReset={() => undefined}
          onSubmit={() => comments.clear()}
          setPromptDockRef={() => undefined}
          hasMessages={false}
          sessionDirectory={props.directory}
          draftId={props.draftId}
          dockMode="side"
          emptyState={
            <div class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <div class="text-13-medium text-text-base">Draft first, attach later</div>
              <div class="max-w-[28rem] text-12-regular text-text-weak">
                This composer keeps its draft identity even before it belongs to a workspace.
              </div>
            </div>
          }
          messages={
            <div class="hidden">
              <For each={[]} children={() => null} />
            </div>
          }
        />
      </div>
    </div>
  )
}
