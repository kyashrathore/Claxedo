// Claxedo keeps workspace-start controls below upstream's composer so local/cloud selection can drive runtime lifecycle.
import type { JSX } from "solid-js"
import { For, Show, createMemo, createSignal } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useNavigate } from "@solidjs/router"
import { getFilename } from "@/lib/path"
import { Select } from "@opencode-ai/ui/select"
import { Icon } from "@opencode-ai/ui/icon"
import { ClaxedoIcon } from "@/ui/controls/claxedo-icon"
import { ClaxedoLogo } from "@/ui/controls/claxedo-logo"
import { useShellQueryOptions as useQueryOptions } from "@/features/session/app-ports"
import { useLayout } from "@/features/session/app-ports"
import { useSDK } from "@/features/session/app-ports"
import { useServer } from "@/features/session/app-ports"
import {
  CREATE_WORKTREE,
  createNewSessionWorkspaceState,
  MAIN_WORKTREE,
  type NewSessionWorkspaceKind,
  type ProjectWorkspace,
} from "./session-new-workspace-options"
import { workspaceSessionRoute } from "@/platform/identity/route"

export type { NewSessionWorkspaceKind } from "./session-new-workspace-options"

type ProjectInventoryItem = {
  worktree: string
  name?: string
  sandboxes?: string[]
  workspaces?: Record<string, ProjectWorkspace>
}

export function NewSessionDesignView(props: {
  worktree: string
  workspaceKind: NewSessionWorkspaceKind
  onWorktreeChange: (value: string) => void
  onWorkspaceKindChange: (value: NewSessionWorkspaceKind) => void
  onProjectChange?: (directory: string) => void
  main?: JSX.Element
  children: JSX.Element
}) {
  const queryOptions = useQueryOptions()
  const layout = useLayout()
  const navigate = useNavigate()
  const sdk = useSDK()
  const server = useServer()
  const [worktreePickerOpen, setWorktreePickerOpen] = createSignal(false)
  const projectsQuery = useQuery(() => queryOptions.projects())

  const inventoryProjects = createMemo(() => (projectsQuery.data ?? []) as ProjectInventoryItem[])
  const activeProject = createMemo(() => {
    const selection = props.worktree === MAIN_WORKTREE || props.worktree === CREATE_WORKTREE ? sdk.directory : props.worktree
    return inventoryProjects().find((project) =>
      project.worktree === sdk.directory ||
      project.sandboxes?.includes(sdk.directory) ||
      sdk.directory in (project.workspaces ?? {}) ||
      project.worktree === selection ||
      project.sandboxes?.includes(selection) ||
      selection in (project.workspaces ?? {}),
    )
  })
  const projectRoot = createMemo(() => activeProject()?.worktree ?? sdk.directory)
  const workspaces = createMemo(() => activeProject()?.workspaces ?? {})
  const sandboxes = createMemo(() => activeProject()?.sandboxes ?? [])
  const workspaceState = createMemo(() =>
    createNewSessionWorkspaceState({
      projectRoot: projectRoot(),
      selectedWorktree: props.worktree,
      workspaceKind: props.workspaceKind,
      sandboxes: sandboxes(),
      workspaces: workspaces(),
    })
  )
  const worktreeOptions = createMemo(() => workspaceState().options)
  const runtimeMode = () => props.main !== undefined
  const currentWorktree = createMemo(() => workspaceState().currentWorktree)
  const creatingWorkspace = createMemo(() => workspaceState().creatingWorkspace)
  const projects = createMemo(() => {
    const roots = inventoryProjects().map((project) => project.worktree)
    if (roots.includes(projectRoot())) return roots
    return [projectRoot(), ...roots]
  })
  // The project options are directory paths. Cloud workspaces live in
  // UUID-named directories, so getFilename(dir) would surface a raw UUID.
  // Prefer the enriched project name (the same one the sidebar shows) and
  // only fall back to the directory's basename when no name is available.
  const projectLabel = (value: string) => {
    // 1) Enriched layout list — the same name the sidebar renders.
    const fromList = (layout.projects.list() ?? []).find((project) => project.worktree === value)?.name?.trim()
    if (fromList) return fromList
    // 2) Global project metadata (if the cross-project list has loaded).
    const fromGlobal = inventoryProjects().find((project) => project.worktree === value)?.name?.trim()
    if (fromGlobal) return fromGlobal
    // 3) The active project resolved from the workspace inventory.
    if (value === projectRoot()) {
      const active = activeProject()?.name?.trim()
      if (active) return active
    }
    // 4) Last resort: the directory basename (a UUID for cloud workspaces).
    return getFilename(value)
  }
  const worktreeLabel = (value: string) => {
    if (value === MAIN_WORKTREE) {
      const workspace = workspaces()[projectRoot()]
      return "main"
    }
    const workspace = workspaces()[value]
    if (workspace?.workspace_name) return workspace.workspace_name
    return getFilename(value)
  }

  // Display name for the pinned self-hosted workspace (the relay-connected
  // machine the route already scopes to). Prefer the inventory workspace_name,
  // fall back to the project label.
  const pinnedWorkspaceName = createMemo(() => {
    const selfHosted = Object.values(workspaces()).find((workspace) => workspace?.kind === "user-hosted")
    return selfHosted?.workspace_name?.trim() || projectLabel(projectRoot())
  })

  const openProject = (directory: string | undefined) => {
    if (!directory) return
    if (directory === projectRoot()) return
    if (props.onProjectChange) {
      props.onProjectChange(directory)
      return
    }
    layout.projects.open(directory)
    server.projects.touch(directory)
    navigate(workspaceSessionRoute(directory))
  }

  return (
    <div data-component="session-new-design" class="relative size-full overflow-hidden bg-background-base">
      <div
        class="absolute inset-x-0 flex justify-center px-6"
        classList={{
          "top-[18%]": runtimeMode(),
          "top-[34%]": !runtimeMode(),
        }}
      >
        <div class="w-full max-w-[720px]">
          <Show when={!runtimeMode()}>
            <div class="mb-5 flex justify-center">
              <ClaxedoLogo class="w-12 opacity-14" />
            </div>
          </Show>
          <div>
            {props.main ?? props.children}
            <Show when={!runtimeMode()}>
              {/* Workspace-start scope row. Desktop: one h-8 line. Mobile: the
                  segmented toggles go icon-only and the row wraps so the
                  worktree picker gets a full-width second line instead of
                  clipping off-screen. `data-claxedo-compact-touch` (container
                  opt-out, app-shell.css) keeps the 40px touch floor from
                  inflating the now-labelled h-6 segment buttons. */}
              <div
                data-claxedo-compact-touch
                class="mt-3 flex h-8 min-w-0 items-center gap-1.5 pl-2 max-md:h-auto max-md:flex-wrap max-md:gap-y-2 max-md:pl-0"
              >
                <Select
                  size="normal"
                  variant="ghost"
                  options={projects()}
                  current={projectRoot()}
                  label={projectLabel}
                  onSelect={openProject}
                  class="max-w-[220px] justify-start text-text-base max-md:max-w-[45vw]"
                  valueClass="truncate text-13-regular text-text-weak"
                />
                <Show
                  when={props.workspaceKind !== "user-hosted"}
                  fallback={
                    <div
                      data-self-hosted-pinned="true"
                      class="flex h-7 min-w-0 items-center gap-2 rounded-md border border-border-weak-base bg-surface-base px-2.5 max-md:flex-1"
                    >
                      <span class="size-1.5 shrink-0 rounded-full bg-surface-success-strong" aria-hidden="true" />
                      <span class="truncate text-13-regular text-text-base">{pinnedWorkspaceName()}</span>
                      <span class="shrink-0 text-12-medium text-text-weak max-md:hidden">· Self-hosted · Connected via relay</span>
                      <span class="hidden shrink-0 text-12-medium text-text-weak max-md:inline">· Self-hosted</span>
                    </div>
                  }
                >
                <div
                  role="group"
                  aria-label="Workspace environment"
                  class="flex h-7 shrink-0 items-center rounded-md border border-border-weak-base bg-surface-base p-0.5"
                >
                  <For each={["local", "cloud"] satisfies NewSessionWorkspaceKind[]}>
                    {(value) => (
                      <button
                        type="button"
                        aria-pressed={props.workspaceKind === value}
                        aria-label={value === "cloud" ? "Cloud workspace" : "Local workspace"}
                        title={value === "cloud" ? "Cloud workspace" : "Local workspace"}
                        class="flex h-6 items-center justify-center rounded-[4px] px-2 text-12-medium capitalize transition-colors"
                        classList={{
                          "bg-background-base text-text-base shadow-xs-border-base": props.workspaceKind === value,
                          "text-text-weak hover:text-text-base": props.workspaceKind !== value,
                        }}
                        onClick={() => props.onWorkspaceKindChange(value)}
                      >
                        <ClaxedoIcon
                          name={value === "cloud" ? "cloud" : "laptop"}
                          size="small"
                          class="md:hidden"
                        />
                        <span class="max-md:hidden">{value}</span>
                      </button>
                    )}
                  </For>
                </div>
                <div
                  role="group"
                  aria-label="Workspace source"
                  class="flex h-7 shrink-0 items-center rounded-md border border-border-weak-base bg-surface-base p-0.5"
                >
                  <button
                    type="button"
                    aria-pressed={!creatingWorkspace()}
                    aria-label="Select existing workspace"
                    title="Select existing workspace"
                    class="flex h-6 items-center justify-center rounded-[4px] px-2 text-12-medium transition-colors"
                    classList={{
                      "bg-background-base text-text-base shadow-xs-border-base": !creatingWorkspace(),
                      "text-text-weak hover:text-text-base": creatingWorkspace() && worktreeOptions().length > 0,
                      "text-text-weaker/50": worktreeOptions().length === 0,
                    }}
                    disabled={worktreeOptions().length === 0}
                    onClick={() => {
                      const next = currentWorktree()
                      if (next) props.onWorktreeChange(next)
                    }}
                  >
                    <ClaxedoIcon name="worktree" size="small" class="md:hidden" />
                    <span class="max-md:hidden">Select</span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={creatingWorkspace()}
                    aria-label="Create new workspace"
                    title="Create new workspace"
                    class="flex h-6 items-center justify-center rounded-[4px] px-2 text-12-medium transition-colors"
                    classList={{
                      "bg-background-base text-text-base shadow-xs-border-base": creatingWorkspace(),
                      "text-text-weak hover:text-text-base": !creatingWorkspace(),
                    }}
                    onClick={() => props.onWorktreeChange(CREATE_WORKTREE)}
                  >
                    <ClaxedoIcon name="plus-small" size="small" class="md:hidden" />
                    <span class="max-md:hidden">Create new</span>
                  </button>
                </div>
                <div
                  data-new-workspace={creatingWorkspace() ? "true" : "false"}
                  class="flex h-7 min-w-0 items-center overflow-hidden rounded-md border border-border-weak-base bg-surface-base max-md:w-full max-md:flex-1"
                >
                  <Show
                    when={!creatingWorkspace()}
                    fallback={
                      <div class="flex h-7 min-w-[170px] items-center gap-2 px-2.5 text-13-regular text-text-weak max-md:min-w-0 max-md:flex-1">
                        <Icon name={props.workspaceKind === "cloud" ? "cloud-upload" : "branch"} size="small" class="shrink-0" />
                        <span class="truncate">
                          New {props.workspaceKind === "cloud" ? "cloud sandbox" : "local worktree"}
                        </span>
                      </div>
                    }
                  >
                    <Select
                      size="normal"
                      variant="ghost"
                      options={worktreeOptions()}
                      current={currentWorktree()}
                      placeholder={props.workspaceKind === "cloud" ? "No cloud workspace" : "No local workspace"}
                      label={worktreeLabel}
                      disabled={worktreeOptions().length === 0}
                      onOpenChange={setWorktreePickerOpen}
                      onSelect={(value) => {
                        if (!worktreePickerOpen()) return
                        if (value) props.onWorktreeChange(value)
                      }}
                      class="max-w-[260px] min-w-[150px] justify-start rounded-none border-0 bg-transparent text-text-base shadow-none disabled:opacity-50 max-md:w-full max-md:min-w-0 max-md:max-w-none"
                      valueClass="truncate text-13-regular text-text-weak"
                    />
                  </Show>
                </div>
                </Show>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}
