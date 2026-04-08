/**
 * Rail Layout
 *
 * The main layout component implementing the "Rail + Tab" architecture.
 * This wraps/replaces the upstream layout when Claxedo mode is enabled.
 *
 * Structure:
 * ┌─────────────────────────────────────────────────────────────┐
 * │                        Titlebar                              │
 * ├────────┬────────────────────────────────────────────────────┤
 * │        │  [Tab1] [Tab2] [Tab3] [+]  │  [Search]  │  [...]  │
 * │  Rail  ├────────────────────────────────────────────────────┤
 * │        │                                                     │
 * │        │               Tab Content Area                      │
 * │        │                                                     │
 * └────────┴────────────────────────────────────────────────────┘
 */

import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onMount,
  onCleanup,
  type ParentProps,
  type JSX,
  type Accessor,
} from "solid-js"
import { DragDropProvider, DragDropSensors, DragOverlay, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { useClaxedoLayout, ClaxedoLayoutProvider, type TabItem } from "../context/claxedo-layout"
import { isGlobalTab, tabScopeDir as scopeDir } from "../context/claxedo-layout/types"
import { RailSidebar, type ProjectItem, type WorkspaceItem, parseOwnerRepo } from "./rail-sidebar"
import { TopTabBar, TabDragOverlay, WorkspaceBar, WorkspaceScopeButtons, type WorkspaceBarProject } from "./top-tab-bar"
import { GroupContentRenderer } from "../components/group-content-renderer"
import { toggleMarkdownPreview, isMarkdownPath } from "../components/tab-file"
import { SDKProvider } from "@/context/sdk"
import { useCommand, useServer, useGlobalSync, usePlatform, getAvatarColors } from "@opencode-ai/claxedo-app"
import { Avatar } from "@opencode-ai/ui/avatar"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { List } from "@opencode-ai/ui/list"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { closeTabLogic } from "./rail-layout-logic"
import { getFilename } from "@opencode-ai/util/path"
import { createDebugLogger } from "../../overrides/utils/debug"
import "../styles.css"

export type RailLayoutProps = ParentProps<{
  /**
   * List of projects to display in the rail
   */
  projects: ProjectItem[]

  /**
   * Currently active project ID
   */
  activeProjectId?: string

  /**
   * Currently active worktree directory (route)
   */
  activeWorkspaceId?: string

  /**
   * Currently active session ID
   */
  activeSessionId?: string
  globalChatEnabled?: boolean
  workgraphEnabled?: boolean

  /**
   * Home directory for path shortening
   */
  homedir?: string

  /**
   * Callback when a project is selected
   */
  onProjectSelect?: (project: ProjectItem) => void

  /**
   * Callback when a worktree is selected
   */
  onWorkspaceSelect?: (project: ProjectItem, workspaceDir: string) => void

  /**
   * Callback when a session is selected
   */
  onSessionSelect?: (workspaceDir: string, sessionId: string) => void

  /**
   * Callback to create a new project
   */
  onNewProject?: () => void

  /**
   * Callback to create a new worktree in a project
   */
  onNewWorkspace?: (project: ProjectItem) => Promise<import("./top-tab-bar").WorkspaceBarItem | undefined>

  /**
   * Callback to create a local worktree directly (no dialog)
   */
  onNewLocalWorkspace?: (
    project: ProjectItem,
    onProgress?: (step: string, message?: string) => void,
    workspaceName?: string,
  ) => Promise<import("./top-tab-bar").WorkspaceBarItem | undefined>

  /**
   * Callback to create a cloud sandbox directly (no dialog).
   * Accepts a progress callback for provisioning step updates.
   */
  onNewCloudWorkspace?: (
    project: ProjectItem,
    onProgress?: (step: string, message?: string) => void,
    workspaceName?: string,
  ) => Promise<import("./top-tab-bar").WorkspaceBarItem | undefined>

  /**
   * Callback to open settings
   */
  onSettings?: () => void

  /**
   * Callback to open help
   */
  onHelp?: () => void

  /**
   * Callback to open WorkGraph
   */
  onOpenWorkGraph?: () => void

  /**
   * Callback to create a new session (with workspace directory)
   */
  onNewSession?: (workspaceDir: string, groupId?: string) => void
  onDeleteSession?: (session: import("./rail-sidebar").SessionItem) => void
  onArchiveSession?: (session: import("./rail-sidebar").SessionItem) => void
  onDeleteWorkspace?: (workspace: import("./rail-sidebar").WorkspaceItem) => void
  onRemoveProject?: (project: import("./rail-sidebar").ProjectItem) => void

  /**
   * Callback to create a new terminal
   * @param workspaceDir - The workspace directory to create the terminal in
   * @param command - Optional command to run in the terminal (e.g., "claude --dangerously-skip-permissions")
   * @param title - Optional title for the terminal tab (e.g., "Claude", "Codex")
   */
  onNewTerminal?: (workspaceDir: string, command?: string, title?: string, groupId?: string) => void

  /**
   * Callback to create a new page
   */
  onNewPage?: (groupId?: string) => void

  /**
   * Callback to create a new review workspace tab
   */
  onNewReview?: (workspaceDir: string, groupId?: string) => void

  /**
   * Callback when a tab is selected
   */
  onTabSelect?: (tab: import("../context/claxedo-layout").TabItem) => void

  /**
   * Callback when a tab is closed (to sync URL with the new active tab)
   */
  onTabClose?: (nextActiveTab: import("../context/claxedo-layout").TabItem | undefined) => void

  /**
   * Render function for empty state (shown when no project selected)
   */
  renderEmpty?: () => JSX.Element

  /**
   * Titlebar component to render
   */
  titlebar?: JSX.Element

  /**
   * Additional content for the top bar (right side)
   */
  topBarRight?: () => JSX.Element
}>

// Check if running inside the Electron desktop shell.
const isDesktopApp = () => typeof window !== "undefined" && !!(window as any).api

// ─── Workspace Selector Popover ──────────────────────────────────────────────

type WorkspaceSelectorItem = {
  id: string
  name: string
  directory: string
  projectId: string
  projectName: string
  isMain: boolean
  isCloud: boolean
}

type WorkspaceSelectorPopoverProps = {
  allProjects: ProjectItem[]
  allWorkspaceItems: () => WorkspaceSelectorItem[]
  currentDir: () => string | undefined
  projectName: () => string
  workspaceName: () => string
  trigger?: JSX.Element
  triggerClass?: string
  triggerLabel?: string
  onWorktreeClick: (projectId: string, dir: string) => void
  onNewLocalWorkspace?: (
    project: ProjectItem,
    onProgress?: (step: string, message?: string) => void,
    workspaceName?: string,
  ) => Promise<{ directory: string } | undefined>
  onNewCloudWorkspace?: (
    project: ProjectItem,
    onProgress?: (step: string, message?: string) => void,
    workspaceName?: string,
  ) => Promise<{ directory: string } | undefined>
}

const CLOUD_PIPELINE = [
  { key: "creating", label: "Creating workspace" },
  { key: "acquiring_sandbox", label: "Acquiring sandbox" },
  { key: "cloning", label: "Cloning repository" },
  { key: "uploading_runtime", label: "Uploading runtime" },
  { key: "starting_runtime", label: "Starting runtime" },
  { key: "waiting_health", label: "Waiting for health check" },
]

const LOCAL_PIPELINE = [
  { key: "creating", label: "Creating worktree" },
]

const WS_ADJECTIVES = [
  "brave", "calm", "clever", "cosmic", "crisp", "curious", "eager", "gentle",
  "glowing", "happy", "hidden", "jolly", "kind", "lucky", "mighty", "misty",
  "neon", "nimble", "playful", "proud", "quick", "quiet", "shiny", "silent",
  "stellar", "sunny", "swift", "tidy", "witty",
]
const WS_NOUNS = [
  "cabin", "cactus", "canyon", "circuit", "comet", "eagle", "engine", "falcon",
  "forest", "garden", "harbor", "island", "knight", "lagoon", "meadow", "moon",
  "mountain", "nebula", "orchid", "otter", "panda", "pixel", "planet", "river",
  "rocket", "sailor", "squid", "star", "tiger", "wizard", "wolf",
]
function randomWorkspaceName() {
  const adj = WS_ADJECTIVES[Math.floor(Math.random() * WS_ADJECTIVES.length)]
  const noun = WS_NOUNS[Math.floor(Math.random() * WS_NOUNS.length)]
  return `${adj}-${noun}`
}

function WorkspaceSelectorPopover(props: WorkspaceSelectorPopoverProps) {
  type Step = "list" | "type" | "name" | "provisioning"
  type CreateType = "local" | "cloud"
  const [step, setStep] = createSignal<Step>("list")
  const [targetProject, setTargetProject] = createSignal<ProjectItem | null>(null)
  const [targetProjectName, setTargetProjectName] = createSignal("")
  const [filterText, setFilterText] = createSignal("")
  const [workspaceName, setWorkspaceName] = createSignal("")
  const [createType, setCreateType] = createSignal<CreateType>("cloud")
  const [provisionSteps, setProvisionSteps] = createSignal<Array<{ step: string; message?: string; ts: number }>>([])
  const [provisionError, setProvisionError] = createSignal("")

  const reset = () => {
    setStep("list")
    setTargetProject(null)
    setTargetProjectName("")
    setFilterText("")
    setWorkspaceName("")
    setCreateType("cloud")
    setProvisionSteps([])
    setProvisionError("")
  }

  const lastPipelineKey = () => {
    const steps = provisionSteps()
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].step !== "ready" && steps[i].step !== "redirecting" && steps[i].step !== "error") {
        return steps[i].step
      }
    }
    return null
  }
  const isProvisionReady = () => provisionSteps().some(s => s.step === "ready")
  const isProvisionRedirecting = () => provisionSteps().some(s => s.step === "redirecting")
  const pipelineStepState = (key: string): "done" | "active" | "pending" | "error" => {
    if (isProvisionReady()) return "done"
    const lastKey = lastPipelineKey()
    if (!lastKey) return "pending"
    const pipeline = createType() === "local" ? LOCAL_PIPELINE : CLOUD_PIPELINE
    const keyIdx = pipeline.findIndex(p => p.key === key)
    const lastIdx = pipeline.findIndex(p => p.key === lastKey)
    if (provisionError() && keyIdx === lastIdx) return "error"
    if (keyIdx === lastIdx) return "active"
    if (keyIdx < lastIdx) return "done"
    return "pending"
  }
  const pipelineStepDuration = (key: string) => {
    const steps = provisionSteps()
    const idx = steps.findIndex(s => s.step === key)
    if (idx === -1) return undefined
    const next = steps[idx + 1]
    if (!next) return undefined
    return ((next.ts - steps[idx].ts) / 1000).toFixed(1)
  }
  const provisionTotalElapsed = () => {
    const steps = provisionSteps()
    const readyStep = steps.find(s => s.step === "ready")
    if (!readyStep || steps.length < 2) return undefined
    return ((readyStep.ts - steps[0].ts) / 1000).toFixed(1)
  }

  const groupedByProject = createMemo(() => {
    const groups: Array<{
      project: ProjectItem
      projectName: string
      workspaces: WorkspaceSelectorItem[]
    }> = []
    const filter = filterText().toLowerCase()
    for (const p of props.allProjects) {
      const items = props.allWorkspaceItems().filter((w) => w.projectId === p.id)
      const pName = items[0]?.projectName ?? p.name ?? getFilename(p.worktree)
      const filtered = items.filter(
        (w) => !filter || w.name.toLowerCase().includes(filter) || pName.toLowerCase().includes(filter),
      )
      if (filtered.length > 0 || pName.toLowerCase().includes(filter)) {
        groups.push({ project: p, projectName: pName, workspaces: filtered })
      }
    }
    return groups
  })

  const handleCreate = async () => {
    const project = targetProject()
    if (!project) return
    const type = createType()
    const name = workspaceName().trim() || undefined
    setStep("provisioning")
    setProvisionSteps([])
    setProvisionError("")
    if (type === "local") {
      await props.onNewLocalWorkspace?.(project, (stepName, message) => {
        if (stepName === "error") {
          setProvisionError(message || "Failed")
          return
        }
        setProvisionSteps((prev) => {
          if (prev.some(s => s.step === stepName)) return prev
          return [...prev, { step: stepName, message, ts: Date.now() }]
        })
      }, name)
      if (!provisionError()) reset()
    } else {
      setProvisionSteps([{ step: "creating", message: "Creating cloud workspace...", ts: Date.now() }])
      await props.onNewCloudWorkspace?.(project, (stepName, message) => {
        if (stepName === "error") {
          setProvisionError(message || "Provisioning failed")
          return
        }
        setProvisionSteps((prev) => {
          if (prev.some(s => s.step === stepName)) return prev
          return [...prev, { step: stepName, message, ts: Date.now() }]
        })
      }, name)
      if (!provisionError()) reset()
    }
  }

  return (
    <Popover
      placement="bottom-start"
      onOpenChange={(open) => { if (!open) reset() }}
      trigger={props.trigger ?? (
        <div class="flex items-baseline gap-1">
          <span class="text-[13px] font-medium text-text-base truncate max-w-[180px]">{props.workspaceName()}</span>
          <span class="text-[9px] text-text-weak/50">·</span>
          <span class="text-[10px] text-text-weak/50 truncate max-w-[180px]">{props.projectName()}</span>
          <Icon name="chevron-down" size="small" class="text-icon-weak shrink-0 ml-0.5 self-center" />
        </div>
      )}
      triggerAs="button"
      triggerProps={{
        class: props.triggerClass ?? "flex items-center shrink-0 pl-3 pr-1 h-full hover:bg-surface-base-hover transition-colors cursor-pointer border-none bg-transparent",
        "aria-label": props.triggerLabel,
      }}
      class="w-[280px] [&_[data-slot=popover-body]]:p-0"
    >
      {/* Step 1: Workspace list */}
      <Show when={step() === "list"}>
        <div class="flex flex-col max-h-[400px] overflow-hidden">
          <div class="flex items-center gap-2 px-3 py-2 border-b border-border-weak-base/50">
            <Icon name="magnifying-glass" size="small" class="text-icon-weak shrink-0" />
            <input
              type="text"
              placeholder="Filter workspaces..."
              value={filterText()}
              onInput={(e) => setFilterText(e.currentTarget.value)}
              class="flex-1 bg-transparent border-none outline-none text-[13px] text-text-base placeholder:text-text-weaker"
              autofocus
            />
          </div>
          <div class="overflow-y-auto flex-1">
            <For each={groupedByProject()}>
              {(group) => (
                <div class="py-1">
                  <div class="flex items-center justify-between px-3 py-1">
                    <span class="text-[11px] font-medium text-text-weaker uppercase tracking-wider truncate">
                      {group.projectName}
                    </span>
                    <button
                      type="button"
                      class="flex items-center justify-center size-5 rounded text-icon-weak hover:text-icon-base hover:bg-surface-base-hover transition-colors cursor-pointer border-none bg-transparent"
                      onClick={(e) => {
                        e.stopPropagation()
                        setTargetProject(group.project)
                        setTargetProjectName(group.projectName)
                        setStep("type")
                      }}
                      aria-label={`Add workspace to ${group.projectName}`}
                    >
                      <Icon name="plus-small" size="small" />
                    </button>
                  </div>
                  <For each={group.workspaces}>
                    {(ws) => (
                      <button
                        type="button"
                        class="flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-surface-base-hover transition-colors cursor-pointer border-none bg-transparent"
                        classList={{ "bg-surface-base-hover/50": props.currentDir() === ws.directory }}
                        onClick={() => props.onWorktreeClick(ws.projectId, ws.directory)}
                      >
                        <Icon name={ws.isCloud ? "cloud" : "laptop"} size="small" class="text-icon-weak shrink-0" />
                        <span class="text-[13px] text-text-base truncate flex-1">{ws.name}</span>
                        <Show when={props.currentDir() === ws.directory}>
                          <Icon name="check-small" size="small" class="text-icon-base shrink-0" />
                        </Show>
                      </button>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* Step 2: Local / Cloud choice */}
      <Show when={step() === "type" && targetProject()}>
        {(project) => (
          <div class="flex flex-col p-3 gap-3">
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="flex items-center justify-center size-6 rounded text-icon-weak hover:text-icon-base hover:bg-surface-base-hover transition-colors cursor-pointer border-none bg-transparent"
                onClick={() => { setStep("list"); setTargetProject(null) }}
              >
                <Icon name="chevron-left" size="small" />
              </button>
              <span class="text-[13px] font-medium text-text-base truncate">New workspace</span>
            </div>
            <span class="text-[11px] text-text-weaker px-1">
              in {targetProjectName() || project().name || getFilename(project().worktree)}
            </span>
            <div class="flex flex-col gap-1.5">
              <button
                type="button"
                class="flex items-center gap-3 w-full px-3 py-2.5 rounded-md hover:bg-surface-base-hover transition-colors cursor-pointer border border-border-weak-base/50 bg-transparent"
                onClick={() => { setCreateType("local"); setWorkspaceName(randomWorkspaceName()); setStep("name") }}
              >
                <div class="flex items-center justify-center size-8 rounded bg-surface-base-hover/50">
                  <Icon name="console" size="small" class="text-icon-base" />
                </div>
                <div class="flex flex-col gap-0.5 text-left">
                  <span class="text-[13px] font-medium text-text-base">Local</span>
                  <span class="text-[11px] text-text-weaker">Git worktree on this machine</span>
                </div>
              </button>
              <button
                type="button"
                class="flex items-center gap-3 w-full px-3 py-2.5 rounded-md hover:bg-surface-base-hover transition-colors cursor-pointer border border-border-weak-base/50 bg-transparent"
                onClick={() => { setCreateType("cloud"); setWorkspaceName(randomWorkspaceName()); setStep("name") }}
              >
                <div class="flex items-center justify-center size-8 rounded bg-surface-base-hover/50">
                  <Icon name="cloud-upload" size="small" class="text-icon-base" />
                </div>
                <div class="flex flex-col gap-0.5 text-left">
                  <span class="text-[13px] font-medium text-text-base">Cloud</span>
                  <span class="text-[11px] text-text-weaker">Remote sandbox environment</span>
                </div>
              </button>
            </div>
          </div>
        )}
      </Show>

      {/* Step 3: Name the cloud workspace */}
      <Show when={step() === "name"}>
        <div class="flex flex-col p-3 gap-3">
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="flex items-center justify-center size-6 rounded text-icon-weak hover:text-icon-base hover:bg-surface-base-hover transition-colors cursor-pointer border-none bg-transparent"
              onClick={() => setStep("type")}
            >
              <Icon name="chevron-left" size="small" />
            </button>
            <span class="text-[13px] font-medium text-text-base truncate">Name your workspace</span>
          </div>
          <input
            type="text"
            placeholder="e.g. feature-auth, staging"
            value={workspaceName()}
            onInput={(e) => setWorkspaceName(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreate() }}
            class="w-full px-3 py-2 rounded-md border border-border-weak-base/50 bg-transparent text-[13px] text-text-base placeholder:text-text-weaker outline-none focus:border-border-base"
            autofocus
          />
          <button
            type="button"
            class="flex items-center justify-center w-full px-3 py-2 rounded-md bg-surface-base-hover hover:bg-surface-base-active transition-colors cursor-pointer border border-border-weak-base/50 text-[13px] font-medium text-text-base"
            onClick={() => handleCreate()}
          >
            Create
          </button>
        </div>
      </Show>

      {/* Step 4: Provisioning in-progress */}
      <Show when={step() === "provisioning"}>
        <div class="flex flex-col gap-2 p-4">
          <span class="text-[12px] font-medium text-text-base mb-1">Provisioning...</span>
          <div class="flex flex-col gap-2 text-[11px]">
            <For each={createType() === "local" ? LOCAL_PIPELINE : CLOUD_PIPELINE}>
              {(pipelineStep) => {
                const state = () => pipelineStepState(pipelineStep.key)
                const duration = () => pipelineStepDuration(pipelineStep.key)
                return (
                  <div class="flex items-center gap-2">
                    <Show when={state() === "active"} fallback={
                      <Show when={state() === "error"} fallback={
                        <Icon name="circle-check" size="small" class="shrink-0" classList={{
                          "text-green-400": state() === "done",
                          "text-text-weaker/20": state() === "pending",
                        }} />
                      }>
                        <Icon name="circle-ban-sign" size="small" class="text-red-400 shrink-0" />
                      </Show>
                    }>
                      <span class="inline-flex items-center justify-center size-4 shrink-0">
                        <span
                          class="size-3 rounded-full border-[1.5px] border-dashed border-accent-base animate-spin"
                          style={{ "animation-duration": "3s" }}
                        />
                      </span>
                    </Show>
                    <span class="truncate flex-1" classList={{
                      "text-text-base": state() === "active",
                      "text-text-weak": state() === "done",
                      "text-text-weaker/40": state() === "pending",
                      "text-red-300": state() === "error",
                    }}>
                      {pipelineStep.label}
                    </span>
                    <Show when={state() === "done" && duration()}>
                      <span class="text-text-weaker tabular-nums shrink-0">{duration()}s</span>
                    </Show>
                  </div>
                )
              }}
            </For>
            <Show when={isProvisionReady()}>
              <div class="flex items-center gap-2">
                <Icon name="circle-check" size="small" class="text-green-400 shrink-0" />
                <span class="text-green-400 flex-1">Ready</span>
                <Show when={provisionTotalElapsed()}>
                  <span class="text-green-400/60 tabular-nums shrink-0">{provisionTotalElapsed()}s</span>
                </Show>
              </div>
            </Show>
            <Show when={isProvisionRedirecting()}>
              <div class="flex items-center gap-2">
                <span class="inline-flex items-center justify-center size-4 shrink-0">
                  <span
                    class="size-3 rounded-full border-[1.5px] border-dashed border-accent-base animate-spin"
                    style={{ "animation-duration": "3s" }}
                  />
                </span>
                <span class="text-accent-base flex-1">Redirecting to new session...</span>
              </div>
            </Show>
          </div>
          <Show when={provisionError()}>
            <div class="flex items-start gap-2 mt-2 px-2 py-1.5 rounded bg-red-500/10 border border-red-500/20">
              <Icon name="warning" size="small" class="text-red-400 mt-0.5 shrink-0" />
              <span class="text-[11px] text-red-400 break-words min-w-0">{provisionError()}</span>
            </div>
            <button
              type="button"
              class="text-[12px] text-text-weak hover:text-text-base mt-1 cursor-pointer border-none bg-transparent"
              onClick={() => { setStep("type"); setProvisionError(""); setProvisionSteps([]) }}
            >
              ← Back
            </button>
          </Show>
        </div>
      </Show>
    </Popover>
  )
}

type GroupPanelProps = {
  groupId: string
  isPrimary: boolean
  props: RailLayoutProps
  workspaceBarProjects: () => WorkspaceBarProject[]
  worktreeInfo: (dir: string) => { name: string; isMain: boolean; tooltip?: string } | undefined
  sidebarPinned: () => boolean
  mobileSidebarOpen: () => boolean
  toggleMobileSidebar: () => void
  allProjects: ProjectItem[]
  visibleWorkspaces: Set<string>
  onToggleWorkspace: (dir: string, visible: boolean) => void
  trafficLightPad: () => boolean
}

function projectWorkspaces(project: ProjectItem, isCloud: boolean): WorkspaceItem[] {
  const items: WorkspaceItem[] = []
  const all = new Set<string>([
    project.worktree,
    ...(project.sandboxes ?? []),
    ...Object.keys(project.workspaces ?? {}),
  ])
  for (const dir of all) {
    const main = dir === project.worktree
    const ws = project.workspaces?.[dir]
    const cloud = ws ? ws.kind === "cloud" : main ? isCloud : false
    const raw = main ? "main" : ws?.workspace_name ?? getFilename(dir)
    items.push({
      id: dir,
      directory: dir,
      name: cloud && raw === "main" ? "main (cloud)" : raw,
      isMain: main,
      projectWorktree: project.worktree,
      isCloud: cloud,
      canDelete: main ? cloud : true,
      available: ws?.available ?? true,
    })
  }
  return items
}

function projectDisplayName(project: ProjectItem, repoName?: string): string {
  return repoName ?? project.name ?? getFilename(project.worktree)
}

function projectHasDir(project: ProjectItem, dir: string) {
  return dir === project.worktree || (project.sandboxes ?? []).includes(dir) || dir in (project.workspaces ?? {})
}

function GroupPanel(gp: GroupPanelProps) {
  const claxedo = useClaxedoLayout()
  const server = useServer()
  const globalSync = useGlobalSync()
  const flow = createDebugLogger("terminal.flow", "terminal:flow", {
    legacyKey: "opencode.debug.terminal",
  })
  const wt = claxedo.groupWorktree(gp.groupId)
  const tabs = createMemo(() => claxedo.groupTabs(gp.groupId))
  const activeTab = createMemo(() => claxedo.select.groupActiveTab(gp.groupId))

  const hasProjects = () => (gp.props.projects?.length ?? 0) > 0

  const projectRepoName = (project: ProjectItem) => {
    const sessions = globalSync.globalSessions.store.byProject[project.id]
    const remote = sessions?.find((s: { git?: { remote?: string } }) => s.git?.remote)?.git?.remote
    return parseOwnerRepo(remote)
  }

  /** Resolve a real workspace directory, excluding process-tab sentinel values. */
  const resolveDir = () => {
    const d = wt.default()
    if (d && d !== "__process__") return d
    const active = activeTab()
    if (active && active.type !== "process") return active.directory
    return undefined
  }

  const resolveSessionId = () => {
    const current = activeTab()
    if (!current) return
    if (current.sessionId && current.sessionId !== "new") return current.sessionId
    const layout = claxedo.multiPane.activeLayout(current.id)
    const values = layout ? Object.values(layout.contents) : []
    return values.find(
      (content) =>
        (content.type === "session" ||
          content.type === "review" ||
          content.type === "review-workspace" ||
          content.type === "context") &&
        content.sessionId &&
        content.sessionId !== "new",
    )?.sessionId
  }

  // NOTE: Auto-tab-creation effect removed. Tabs are created explicitly via:
  // - Session select from sidebar (handleSessionSelect)
  // - New session button (handleNewSession)
  // - Route intent (route-intent.ts)
  // This allows the empty state to show when all tabs are closed.

  return (
    <div class="flex flex-col h-full w-full overflow-hidden">
      {/* When no projects exist, show only the empty state */}
      <Show when={!hasProjects()}>
        <div class="flex flex-col items-center justify-center h-full text-text-weak gap-4">
          <span class="text-14-regular">No projects yet. Create one to get started.</span>
          <Button icon="plus-small" onClick={() => gp.props.onNewProject?.()}>
            New Project
          </Button>
        </div>
      </Show>

      <Show when={hasProjects()}>
        {(() => {
          const activeGlobal = createMemo(() => {
            const tab = activeTab()
            return !!tab && isGlobalTab(tab)
          })
          const currentDir = createMemo(() => {
            const tab = activeTab()
            if (tab && !isGlobalTab(tab) && tab.type !== "process") return tab.directory
            const pinned = wt.pinned()
            if (pinned && pinned !== "__process__") return pinned
            const dir = wt.default()
            if (dir && dir !== "__process__") return dir
            return undefined
          })
          const currentProject = createMemo(() => {
            const dir = currentDir()
            if (!dir) return undefined
            return gp.props.projects.find((p) => projectHasDir(p, dir))
          })
          const projectName = createMemo(() => {
            const proj = currentProject()
            if (!proj) return ""
            return projectDisplayName(proj, projectRepoName(proj))
          })
          const workspaceName = createMemo(() => {
            const dir = currentDir()
            if (!dir) return ""
            const info = gp.worktreeInfo(dir)
            return info?.name || getFilename(dir)
          })
          // Flatten all workspaces for the dropdown
          const allWorkspaceItems = createMemo(() => {
            const list: Array<{
              id: string
              name: string
              directory: string
              projectId: string
              projectName: string
              isMain: boolean
              isCloud: boolean
            }> = []
            for (const p of gp.allProjects) {
              const pName = projectDisplayName(p, projectRepoName(p))
              for (const ws of projectWorkspaces(p, !server.isLocal())) {
                list.push({
                  id: ws.id,
                  name: ws.name || getFilename(ws.directory),
                  directory: ws.directory,
                  projectId: p.id,
                  projectName: pName,
                  isMain: !!ws.isMain,
                  isCloud: !!ws.isCloud,
                })
              }
            }
            return list
          })

          const handleWorktreeClick = (projectId: string, dir: string) => {
            flow.log("workspace bar click", {
              groupId: gp.groupId,
              projectId,
              clickedDir: dir,
              currentDefault: wt.default(),
              currentPinned: wt.pinned(),
              activeTabId: tabs().activeId(),
              activeTabDir: tabs().active()?.directory,
            })
            claxedo.processPane.setTargetDirectory?.(dir)
            claxedo.dispatch({ type: "SplitFocusRequested", groupId: gp.groupId })
            const project = gp.props.projects.find((p) => p.id === projectId)
            if (project && gp.props.onWorkspaceSelect) {
              gp.props.onWorkspaceSelect(project, dir)
              return
            }
            claxedo.workspaceRecency.recordAccess(projectId, dir)
            if (wt.pinned() && wt.pinned() !== dir) wt.setPinned(null)
            wt.setDefault(dir)
          }

          const handleNewSession = () => {
            const dir = resolveDir()
            if (!dir) return
            flow.log("new session button", {
              groupId: gp.groupId,
              dir,
              defaultDir: wt.default(),
              activeTabId: tabs().activeId(),
              activeTabDir: tabs().active()?.directory,
            })
            gp.props.onNewSession?.(dir, gp.groupId)
          }

          const handleNewTerminal = (command?: string, title?: string) => {
            const dir = resolveDir()
            if (!dir) return
            flow.log("new terminal button", {
              groupId: gp.groupId,
              dir,
              command,
              title,
              defaultDir: wt.default(),
              activeTabId: tabs().activeId(),
              activeTabDir: tabs().active()?.directory,
            })
            gp.props.onNewTerminal?.(dir, command, title, gp.groupId)
          }

          const sidebarToggle = gp.isPrimary
            ? () => {
              if (window.innerWidth < 768) {
                gp.toggleMobileSidebar()
              } else {
                claxedo.rail.toggle()
              }
            }
            : undefined

          return (
            <>
              {/* Merged bar: workspace selector | tabs | action cluster */}
              <div
                class="flex items-center shrink-0 h-9 bg-background-base overflow-hidden"
                style={{ "padding-left": gp.trafficLightPad() && !gp.sidebarPinned() && gp.isPrimary ? "78px" : undefined }}
                onPointerDown={() => claxedo.dispatch({ type: "SplitFocusRequested", groupId: gp.groupId })}
              >
                {/* Sidebar toggle */}
                <Show when={!gp.sidebarPinned() && sidebarToggle}>
                  <div class="flex items-center ml-2 shrink-0">
                    <IconButton
                      icon="layout-left-partial"
                      size="small"
                      variant="ghost"
                      class="shrink-0 rounded max-md:hidden"
                      onClick={() => sidebarToggle?.()}
                      aria-label="Show Sidebar"
                    />
                    <IconButton
                      icon="menu"
                      size="small"
                      variant="ghost"
                      class="shrink-0 rounded md:hidden"
                      onClick={() => sidebarToggle?.()}
                      aria-label="Open Menu"
                    />
                  </div>
                </Show>

                {/* Compact workspace selector */}
                <Show when={!gp.sidebarPinned() && (currentDir() || activeGlobal())}>
                  <Show
                    when={activeGlobal()}
                    fallback={
                      <div class="flex items-baseline min-w-0 shrink pl-2 gap-1">
                        <span class="text-[13px] font-medium text-text-base truncate">{workspaceName() || projectName()}</span>
                        <Show when={workspaceName() && projectName()}>
                          <span class="text-[9px] text-text-weak/50">·</span>
                          <span class="text-[10px] text-text-weak/50 truncate">{projectName()}</span>
                        </Show>
                      </div>
                    }
                  >
                    <div class="flex items-center min-w-0 shrink pl-3">
                      <div class="min-w-0 flex flex-col justify-center leading-none">
                        <span class="text-[12px] font-medium text-text-base truncate">Global</span>
                      </div>
                    </div>
                  </Show>
                  <WorkspaceSelectorPopover
                    allProjects={gp.allProjects}
                    allWorkspaceItems={allWorkspaceItems}
                    currentDir={() => currentDir() ?? undefined}
                    projectName={projectName}
                    workspaceName={workspaceName}
                    trigger={<Icon name="plus-small" size="small" />}
                    triggerClass="flex items-center justify-center size-7 rounded text-icon-weak hover:text-icon-base hover:bg-surface-base-hover transition-colors cursor-pointer border-none bg-transparent ml-1"
                    triggerLabel="Select or create workspace"
                    onWorktreeClick={handleWorktreeClick}
                    onNewLocalWorkspace={async (project, onProgress, wsName) => {
                      const result = await gp.props.onNewLocalWorkspace?.(project, onProgress, wsName)
                      if (result) handleWorktreeClick(project.id, result.directory)
                      return result
                    }}
                    onNewCloudWorkspace={async (project, onProgress, wsName) => {
                      const result = await gp.props.onNewCloudWorkspace?.(project, onProgress, wsName)
                      if (result) handleWorktreeClick(project.id, result.directory)
                      return result
                    }}
                  />

                  {/* Separator */}
                  <div class="w-px h-4 bg-border-weak-base mx-1 shrink-0" />
                </Show>

                {/* Tabs */}
                <TopTabBar
                  groupId={gp.groupId}
                  embedded
                  onNewReview={() => {
                    const dir = resolveDir()
                    if (!dir) return
                    gp.props.onNewReview?.(dir, gp.groupId)
                  }}
                  onToggleReviewPane={() => {
                    const dir = resolveDir()
                    if (!dir) return
                    const current = activeTab()
                    if (!current) return
                    const sessionId = resolveSessionId()
                    const mode = sessionId ? "session" : "uncommitted"
                    claxedo.multiPane.toggleReviewWorkspace(current.id, dir, sessionId, mode)
                  }}
                  onTabSelect={gp.props.onTabSelect}
                  onTabClose={gp.props.onTabClose}
                  onToggleFileTree={() => {
                    const dir = resolveDir()
                    if (!dir) return
                    const current = activeTab()
                    if (!current) return
                    claxedo.dispatch({
                      type: "FileTreePaneToggleRequested",
                      tabId: current.id,
                      directory: dir,
                    })
                  }}
                  fileTreeActive={(() => {
                    const current = activeTab()
                    return current ? claxedo.multiPane.hasFileTree(current.id) : false
                  })()}
                  reviewPaneActive={(() => {
                    const current = activeTab()
                    return current ? claxedo.multiPane.hasReviewWorkspace(current.id) : false
                  })()}
                  worktreeInfo={gp.worktreeInfo}
                  class="flex-1 min-w-0"
                />

                {/* Separator */}
                <div class="w-px h-4 bg-border-weak-base mx-1 shrink-0" />

                {/* Action cluster */}
                <WorkspaceScopeButtons
                  global={activeGlobal()}
                  onNewSession={handleNewSession}
                  onNewTerminal={handleNewTerminal}
                  onNewPage={() => gp.props.onNewPage?.(gp.groupId)}
                  onSettings={gp.props.onSettings}
                />

                {/* Right side content (search, share, etc.) */}
                <Show when={gp.isPrimary && gp.props.topBarRight}>
                  <div class="flex items-center gap-2 px-2 shrink-0">
                    {gp.props.topBarRight?.()}
                  </div>
                </Show>
              </div>


              {/* Content area */}
              <div class="relative flex-1 min-h-0 overflow-hidden">
                <GroupContentRenderer
                  groupId={gp.groupId}
                  renderEmpty={() => (
                    <div class="flex flex-col items-center justify-center h-full text-text-weak gap-4">
                      <span class="text-14-regular">Select a session or create a new one</span>
                      <Button icon="plus-small" onClick={() => gp.props.onNewProject?.()}>
                        New Project
                      </Button>
                    </div>
                  )}
                />
              </div>
            </>
          )
        })()}
      </Show>
    </div>
  )
}

/** Draggable handle between split groups to resize them. */
function SplitResizeHandle(props: { index: number }) {
  const claxedo = useClaxedoLayout()
  const isH = () => claxedo.split.direction() === "h"

  const handlePointerDown = (e: PointerEvent) => {
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    const container = el.parentElement
    if (!container) return

    const rect = container.getBoundingClientRect()
    const span = isH() ? rect.width : rect.height
    if (span <= 0) return

    const startPos = isH() ? e.clientX : e.clientY
    const startSizes = [...claxedo.split.sizes()]
    const a = props.index - 1
    const b = props.index

    el.setPointerCapture(e.pointerId)
    document.body.style.userSelect = "none"
    document.body.style.cursor = isH() ? "col-resize" : "row-resize"
    document.documentElement.dataset.terminalResizeSuspended = "1"

    const onMove = (me: PointerEvent) => {
      const pos = isH() ? me.clientX : me.clientY
      const delta = (pos - startPos) / span
      const minFrac = 0.15
      const newA = Math.max(minFrac, Math.min(startSizes[a] + startSizes[b] - minFrac, startSizes[a] + delta))
      const newB = startSizes[a] + startSizes[b] - newA
      const next = [...startSizes]
      next[a] = newA
      next[b] = newB
      claxedo.dispatch({ type: "SplitSizesSetRequested", sizes: next })
    }

    const onUp = () => {
      document.body.style.userSelect = ""
      document.body.style.cursor = ""
      delete document.documentElement.dataset.terminalResizeSuspended
      window.dispatchEvent(new Event("opencode:terminal-fit"))
      el.removeEventListener("pointermove", onMove)
      el.removeEventListener("pointerup", onUp)
    }

    el.addEventListener("pointermove", onMove)
    el.addEventListener("pointerup", onUp)
  }

  return (
    <div
      class={
        isH()
          ? "w-px shrink-0 bg-border-weak-base cursor-col-resize hover:bg-blue-500/40 active:bg-blue-500/60 transition-colors max-md:hidden"
          : "h-px shrink-0 bg-border-weak-base cursor-row-resize hover:bg-blue-500/40 active:bg-blue-500/60 transition-colors max-md:hidden"
      }
      onPointerDown={handlePointerDown}
    />
  )
}

/**
 * Shared DragDropProvider for cross-panel tab dragging.
 * Wraps all split groups so sortables/droppables from different panels
 * register with the same provider.
 */
function SharedTabDragDrop(props: { children: JSX.Element }) {
  const claxedo = useClaxedoLayout()
  const [draggedTab, setDraggedTab] = createSignal<TabItem | undefined>()

  const GROUP_ZONE_PREFIX = "group-zone-"

  const handleDragStart = (event: { draggable: { id: unknown } }) => {
    const id = event.draggable?.id
    if (typeof id !== "string") return

    // Find the tab across all groups
    const groupId = claxedo.findTabGroup(id)
    if (!groupId) return
    const tab = claxedo
      .groupTabs(groupId)
      .orderedItems()
      .find((t) => t.id === id)
    setDraggedTab(tab)
  }

  const handleDragEnd = (event: DragEvent) => {
    const { draggable, droppable } = event

    if (draggable && droppable) {
      const dragId = draggable.id.toString()
      const dropId = droppable.id.toString()

      const fromGroupId = claxedo.findTabGroup(dragId)
      // Determine target group: either from a tab ID or from a group zone droppable
      const toGroupId = dropId.startsWith(GROUP_ZONE_PREFIX)
        ? dropId.slice(GROUP_ZONE_PREFIX.length)
        : claxedo.findTabGroup(dropId)

      // Cross-group transfer: move tab on drop
      if (fromGroupId && toGroupId && fromGroupId !== toGroupId) {
        claxedo.dispatch({ type: "TabMoveAcrossGroupsRequested", tabId: dragId, fromGroupId, toGroupId })
      }
    }

    setDraggedTab(undefined)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const dragId = draggable.id.toString()
    const dropId = droppable.id.toString()

    // Skip group zone droppables for reorder — they only matter on drop
    if (dropId.startsWith(GROUP_ZONE_PREFIX)) return

    const fromGroupId = claxedo.findTabGroup(dragId)
    const toGroupId = claxedo.findTabGroup(dropId)

    // Same group → check if same worktree before reorder
    if (fromGroupId && toGroupId && fromGroupId === toGroupId) {
      const tabs = claxedo.groupTabs(fromGroupId)
      const dragTab = tabs.items().find((t) => t.id === dragId)
      const dropTab = tabs.items().find((t) => t.id === dropId)

      // Only allow reorder if tabs are in same worktree (directory)
      if (!dragTab?.directory || !dropTab?.directory || !claxedo.canDragTabBetweenWorktrees(dragTab.directory, dropTab.directory)) {
        return
      }

      const ids = tabs.order().length ? tabs.order() : tabs.orderedItems().map((t) => t.id)
      const fromIndex = ids.indexOf(dragId)
      const toIndex = ids.indexOf(dropId)
      if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
        tabs.move(dragId, toIndex)
      }
    }
    // Different groups → no-op (transfer happens in handleDragEnd)
  }

  return (
    <DragDropProvider
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      collisionDetector={closestCenter}
    >
      <DragDropSensors />
      {props.children}
      <DragOverlay>
        <TabDragOverlay tab={draggedTab()} />
      </DragOverlay>
    </DragDropProvider>
  )
}

function RailLayoutBody(props: RailLayoutProps) {
  const claxedo = useClaxedoLayout()
  const command = useCommand()
  const platform = usePlatform()
  const server = useServer()
  const globalSync = useGlobalSync()
  const dialog = useDialog()

  // macOS traffic light padding: only when desktop + macOS + not fullscreen
  const isMac = platform.platform === "desktop" && platform.os === "macos"
  const [macFullscreen, setMacFullscreen] = createSignal(false)
  onMount(() => {
    if (!isMac) return

    const api = typeof window !== "undefined" ? (window as any).api : undefined
    const guess = () => {
      const fs = window.innerHeight >= screen.height
      setMacFullscreen(fs)
    }
    const sync = () => {
      if (!api?.getWindowFullscreen) {
        guess()
        return
      }
      guess()
      void api.getWindowFullscreen().then(setMacFullscreen).catch(guess)
    }

    sync()

    if (api?.onFullscreenChange) {
      const unsub = api.onFullscreenChange((fs: boolean) => {
        setMacFullscreen(fs)
      })
      onCleanup(unsub)
      return
    }

    window.addEventListener("resize", guess)
    onCleanup(() => window.removeEventListener("resize", guess))
  })
  const trafficLightPad = () => isMac && !macFullscreen()

  const projectRepoName = (project: ProjectItem) => {
    const sessions = globalSync.globalSessions.store.byProject[project.id]
    const remote = sessions?.find((s: { git?: { remote?: string } }) => s.git?.remote)?.git?.remote
    return parseOwnerRepo(remote)
  }

  const sidebarPinned = () => claxedo.rail.pinned()
  const hasActiveTabs = createMemo(() => {
    const focusedId = claxedo.split.focusedId()
    if (!focusedId) return false
    return (claxedo.groupTabs(focusedId).items()?.length ?? 0) > 0
  })
  const activeGlobal = createMemo(() => {
    const focusedId = claxedo.split.focusedId()
    if (!focusedId) return false
    const tab = claxedo.groupTabs(focusedId).active()
    return !!tab && isGlobalTab(tab)
  })

  // Dispatch terminal fit when workspace-level split state changes
  // (toggle split, show/hide split). Deferred to skip the initial mount.
  createEffect(
    on(
      () => [claxedo.split.active(), claxedo.split.hidden()],
      () => {
        setTimeout(() => window.dispatchEvent(new Event("opencode:terminal-fit")), 150)
      },
      { defer: true },
    ),
  )

  // Mobile sidebar state - separate from desktop pinned state
  const [mobileSidebarOpen, setMobileSidebarOpen] = createSignal(false)

  const toggleMobileSidebar = () => setMobileSidebarOpen(!mobileSidebarOpen())
  const closeMobileSidebar = () => setMobileSidebarOpen(false)

  // Track explicitly visible workspaces (checkbox state)
  // These are workspaces the user has chosen to show in the bar even without open tabs
  const [visibleWorkspaces, setVisibleWorkspaces] = createSignal<Set<string>>(new Set())

  const toggleWorkspaceVisibility = (dir: string, visible: boolean) => {
    setVisibleWorkspaces((prev) => {
      const next = new Set(prev)
      if (visible) next.add(dir)
      else next.delete(dir)
      return next
    })
  }

  // Register keyboard shortcuts
  command.register(() => [
    {
      id: "claxedo.tab.close",
      title: "Close Tab",
      category: "View",
      keybind: "mod+w",
      onSelect: () => closeTabLogic(claxedo, platform, dialog, { Dialog, Button }),
    },
    {
      id: "claxedo.tab.next",
      title: "Next Tab",
      category: "View",
      keybind: "mod+tab",
      onSelect: () => {
        const focusedId = claxedo.split.focusedId()
        claxedo.groupTabs(focusedId!).activateNext()
      },
    },
    {
      id: "claxedo.tab.previous",
      title: "Previous Tab",
      category: "View",
      keybind: "mod+shift+tab",
      onSelect: () => {
        const focusedId = claxedo.split.focusedId()
        claxedo.groupTabs(focusedId!).activatePrevious()
      },
    },
    {
      id: "claxedo.tab.reopen",
      title: "Reopen Closed Tab",
      category: "View",
      keybind: "mod+shift+t",
      onSelect: () => {
        const focusedId = claxedo.split.focusedId()
        claxedo.groupTabs(focusedId!).reopenLast()
      },
    },
    {
      id: "claxedo.sidebar.toggle",
      title: "Toggle Sidebar",
      category: "View",
      keybind: "mod+b",
      onSelect: () => claxedo.rail.toggle(),
    },
    // Tab switching shortcuts (Cmd+1 through Cmd+9)
    // Index into visible tabs grouped by directory (matching visual tab bar order)
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `claxedo.tab.${i + 1}`,
      title: `Switch to Tab ${i + 1}`,
      category: "View",
      keybind: `mod+${i + 1}`,
      onSelect: () => {
        const focusedId = claxedo.split.focusedId()
        if (!focusedId) return
        const tabs = claxedo.groupTabs(focusedId)
        const wt = claxedo.groupWorktree(focusedId)
        const pinned = wt.pinned()
        const selected = wt.default()
        const active = tabs.active()
        const scope =
          active &&
            (active.type === "session" ||
              active.type === "review" ||
              active.type === "review-workspace" ||
              active.type === "context" ||
              active.type === "file" ||
              active.type === "page")
            ? active.directory
            : selected
        const tabScopeDir = (tab: TabItem) => {
          return scopeDir(tab, scope)
        }
        const ordered = tabs.visualOrderedItems()
        const scopeFiltered = pinned
          ? ordered.filter((t) => isGlobalTab(t) || tabScopeDir(t) === pinned)
          : !scope
            ? ordered
            : ordered.filter((t) => {
              if (isGlobalTab(t)) return true
              if (t.type === "review" || t.type === "review-workspace" || t.type === "context" || t.type === "file" || t.type === "page")
                return tabScopeDir(t) === scope
              return true
            })
        const groups = new Map<string | undefined, TabItem[]>()
        for (const tab of scopeFiltered) {
          const dir = tabScopeDir(tab)
          const list = groups.get(dir)
          if (list) {
            list.push(tab)
            continue
          }
          groups.set(dir, [tab])
        }
        const visible = Array.from(groups.values()).flat()
        const tab = visible[i]
        if (tab) tabs.setActive(tab.id)
      },
    })),
    // Split view shortcuts
    {
      id: "claxedo.split.toggle",
      title: "Toggle Split View",
      category: "View",
      keybind: "mod+\\",
      onSelect: () => claxedo.dispatch({ type: "SplitToggleRequested" }),
    },
    {
      id: "claxedo.split.focusLeft",
      title: "Focus Left/Top Panel",
      category: "View",
      keybind: "mod+alt+ArrowLeft",
      onSelect: () => {
        const groups = claxedo.split.orderedGroups()
        const focusedId = claxedo.split.focusedId()
        const idx = groups.findIndex((g) => g.id === focusedId)
        if (idx > 0) claxedo.dispatch({ type: "SplitFocusRequested", groupId: groups[idx - 1].id })
      },
    },
    {
      id: "claxedo.split.focusRight",
      title: "Focus Right/Bottom Panel",
      category: "View",
      keybind: "mod+alt+ArrowRight",
      onSelect: () => {
        const groups = claxedo.split.orderedGroups()
        const focusedId = claxedo.split.focusedId()
        const idx = groups.findIndex((g) => g.id === focusedId)
        if (idx < groups.length - 1) claxedo.dispatch({ type: "SplitFocusRequested", groupId: groups[idx + 1].id })
      },
    },
    {
      id: "file.preview.toggle",
      title: "Toggle Markdown Preview",
      category: "View",
      keybind: "mod+shift+v",
      onSelect: () => {
        const focusedId = claxedo.split.focusedId()
        if (!focusedId) return
        const tab = claxedo.groupTabs(focusedId).active()
        if (!tab || tab.type !== "file" || !tab.filePath) return
        if (!isMarkdownPath(tab.filePath)) return
        toggleMarkdownPreview(tab.filePath)
      },
    },
  ])

  // Build workspace bar projects data from open tabs AND explicit visibility
  const workspaceBarProjects = createMemo((): WorkspaceBarProject[] => {
    // Get all open tabs from all groups
    const allTabs: TabItem[] = []
    const groups = claxedo.split.orderedGroups()
    for (const group of groups) {
      const tabs = claxedo.groupTabs(group.id)
      allTabs.push(...tabs.items())
    }

    // Get unique directories from open tabs
    const tabDirs = new Set(allTabs.map((t) => t.directory))

    // Always include each group's selected/pinned workspaces so a workspace
    // chosen in any panel appears in the workspace bar immediately.
    for (const group of groups) {
      const wt = claxedo.groupWorktree(group.id)
      const pinned = wt.pinned()
      if (pinned) tabDirs.add(pinned)
      const selected = wt.default()
      if (selected) tabDirs.add(selected)
    }

    // Add explicitly visible workspaces
    const visible = visibleWorkspaces()
    for (const dir of visible) {
      tabDirs.add(dir)
    }

    return props.projects.flatMap((project) => {
      const workspaces = projectWorkspaces(project, !server.isLocal()).filter((workspace) => tabDirs.has(workspace.directory))
      if (workspaces.length === 0) return []
      return [{
        id: project.id,
        name: projectDisplayName(project, projectRepoName(project)),
        worktree: project.worktree,
        workspaces: workspaces.map((workspace) => ({
          id: workspace.id,
          directory: workspace.directory,
          name: workspace.name || getFilename(workspace.directory),
          notification: false,
          isMain: workspace.isMain,
          isCloud: workspace.isCloud,
          projectWorktree: workspace.projectWorktree,
          canDelete: workspace.canDelete,
          available: workspace.available,
        })),
      }]
    })
  })

  const worktreeInfo = (dir: string) => {
    const proj = props.projects.find((p) => projectHasDir(p, dir))
    if (!proj) return
    const ws = projectWorkspaces(proj, !server.isLocal()).find((item) => item.directory === dir)
    const name = ws?.name || getFilename(dir)
    return { name, isMain: !!ws?.isMain, tooltip: `🌳 ${name}` }
  }

  const visibleGroups = createMemo(() => claxedo.select.visibleGroups())

  const sidebarDir = createMemo(() => {
    const focusedId = claxedo.split.focusedId()
    if (!focusedId) return props.activeWorkspaceId
    const wt = claxedo.groupWorktree(focusedId)
    const tab = claxedo.groupTabs(focusedId).active()
    if (tab && !isGlobalTab(tab) && tab.type !== "process") return tab.directory
    const pinned = wt.pinned()
    if (pinned && pinned !== "__process__") return pinned
    const dir = wt.default()
    if (dir && dir !== "__process__") return dir
    return props.activeWorkspaceId
  })
  const sidebarProject = createMemo(() => {
    const dir = sidebarDir()
    if (dir) {
      const hit = props.projects.find((p) => projectHasDir(p, dir))
      if (hit) return hit
    }
    if (props.activeProjectId) return props.projects.find((p) => p.id === props.activeProjectId)
    return undefined
  })

  // Workspace selector for sidebar header (same popover as merged bar)
  const sidebarProjectName = createMemo(() => {
    const proj = sidebarProject()
    return proj ? projectDisplayName(proj, projectRepoName(proj)) : ""
  })
  const sidebarWorkspaceName = createMemo(() => {
    const dir = sidebarDir()
    if (!dir) return ""
    const info = worktreeInfo(dir)
    return info?.name || getFilename(dir)
  })
  const sidebarAllWorkspaceItems = createMemo(() => {
    const list: WorkspaceSelectorItem[] = []
    for (const p of props.projects) {
      const pName = projectDisplayName(p, projectRepoName(p))
      for (const ws of projectWorkspaces(p, !server.isLocal())) {
        list.push({
          id: ws.id,
          name: ws.name || getFilename(ws.directory),
          directory: ws.directory,
          projectId: p.id,
          projectName: pName,
          isMain: !!ws.isMain,
          isCloud: !!ws.isCloud,
        })
      }
    }
    return list
  })
  const sidebarHandleWorktreeClick = (projectId: string, dir: string) => {
    const project = props.projects.find((p) => p.id === projectId)
    if (project) props.onWorkspaceSelect?.(project, dir)
    closeMobileSidebar()
  }

  const sidebarWorkspaceSelector = () => {
    if (!activeGlobal() && !sidebarDir()) return undefined
    return (
      <WorkspaceSelectorPopover
        allProjects={props.projects}
        allWorkspaceItems={sidebarAllWorkspaceItems}
        currentDir={sidebarDir}
        projectName={sidebarProjectName}
        workspaceName={sidebarWorkspaceName}
        trigger={<Icon name="plus-small" size="small" />}
        triggerClass="flex items-center justify-center size-7 rounded text-icon-weak hover:text-icon-base hover:bg-surface-base-hover transition-colors cursor-pointer border-none bg-transparent"
        triggerLabel="Select or create workspace"
        onWorktreeClick={sidebarHandleWorktreeClick}
        onNewLocalWorkspace={async (project, onProgress, wsName) => {
          const result = await props.onNewLocalWorkspace?.(project, onProgress, wsName)
          if (result) sidebarHandleWorktreeClick(project.id, result.directory)
          return result
        }}
        onNewCloudWorkspace={async (project, onProgress, wsName) => {
          const result = await props.onNewCloudWorkspace?.(project, onProgress, wsName)
          if (result) sidebarHandleWorktreeClick(project.id, result.directory)
          return result
        }}
      />
    )
  }

  return (
    <div class="flex flex-col w-full h-full bg-background-base overflow-hidden" data-claxedo>
      {/* Desktop window chrome spacer - for macOS traffic lights / Windows title bar */}



      <div class="flex flex-1 min-h-0 overflow-hidden relative">
        {/* Mobile backdrop - closes sidebar when tapped */}
        <Show when={mobileSidebarOpen()}>
          <div class="fixed inset-0 bg-black/50 z-[90] md:hidden" onClick={closeMobileSidebar} />
        </Show>

        {/* Sidebar container - desktop: floats/pinned, mobile: slide-in overlay */}
        <div
          class={`
            flex flex-col
            transition-all duration-200 ease-out
            ${sidebarPinned()
              ? "relative z-10 shrink-0 h-full"
              : "absolute top-0 left-0 bottom-0 z-[100] pointer-events-none"
            }
            max-md:fixed max-md:top-0 max-md:left-0 max-md:bottom-0 max-md:z-[100] max-md:pointer-events-auto
            max-md:transition-transform max-md:duration-300 max-md:ease-in-out
            ${mobileSidebarOpen() ? "max-md:translate-x-0" : "max-md:-translate-x-full"}
          `}
        >
          {/* Rail Sidebar - fills full height */}
          <div class="flex-1 min-h-0 h-full">
            <RailSidebar
              projects={props.projects}
              activeProjectId={props.activeProjectId}
              activeWorkspaceId={props.activeWorkspaceId}
              activeSessionId={props.activeSessionId}
              activeGlobal={activeGlobal()}
              globalChatEnabled={props.globalChatEnabled}
              headerTitle={activeGlobal() ? "Global" : sidebarWorkspaceName()}
              headerSubtitle={activeGlobal() ? undefined : sidebarProjectName()}
              hasActiveTabs={hasActiveTabs()}
              homedir={props.homedir}
              onProjectSelect={(project) => {
                props.onProjectSelect?.(project)
                closeMobileSidebar()
              }}
              onWorkspaceSelect={(project, workspaceDir) => {
                props.onWorkspaceSelect?.(project, workspaceDir)
                closeMobileSidebar()
              }}
              onSessionSelect={(workspaceDir, sessionId) => {
                props.onSessionSelect?.(workspaceDir, sessionId)
                closeMobileSidebar()
              }}
              onNewSession={(workspaceDir) => {
                props.onNewSession?.(workspaceDir)
                closeMobileSidebar()
              }}
              onDeleteSession={props.onDeleteSession}
              onArchiveSession={props.onArchiveSession}
              onDeleteWorkspace={props.onDeleteWorkspace}
              onRemoveProject={props.onRemoveProject}
              onNewWorkspace={async (project) => {
                const result = await props.onNewWorkspace?.(project)
                if (result) {
                  toggleWorkspaceVisibility(result.directory, true)
                }
                closeMobileSidebar()
                return result
              }}
              onNewProject={() => {
                props.onNewProject?.()
                closeMobileSidebar()
              }}
              onSettings={() => {
                props.onSettings?.()
                closeMobileSidebar()
              }}
              onHelp={() => {
                props.onHelp?.()
                closeMobileSidebar()
              }}
              onOpenWorkGraph={() => {
                props.onOpenWorkGraph?.()
                closeMobileSidebar()
              }}
              workgraphEnabled={props.workgraphEnabled}
              trafficLightPad={trafficLightPad()}
              workspaceSelector={sidebarWorkspaceSelector()}
            />
          </div>
        </div>

        <div class="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden bg-background-stronger transition-all duration-200 ease-out">
          <SharedTabDragDrop>
            <div
              class="flex flex-1 min-h-0 overflow-hidden"
              style={{ "flex-direction": claxedo.split.direction() === "h" ? "row" : "column" }}
            >
              <For each={visibleGroups()}>
                {(group, i) => (
                  <>
                    <Show when={i() > 0}>
                      <SplitResizeHandle index={i()} />
                    </Show>
                    <div
                      data-group-id={group.id}
                      data-group-focused={group.id === claxedo.split.focusedId() ? "" : undefined}
                      style={{
                        flex: claxedo.split.hidden() ? "1 1 100%" : `0 0 ${claxedo.split.sizes()[i()] * 100}%`,
                        opacity: claxedo.split.active() && group.id !== claxedo.split.focusedId() ? "0.7" : "1",
                      }}
                      class="min-w-0 min-h-0 overflow-hidden relative transition-opacity max-md:!flex-auto"
                      classList={{
                        "max-md:hidden": group.id !== claxedo.split.focusedId() && !claxedo.split.hidden(),
                      }}
                      on:pointerdown={() => claxedo.dispatch({ type: "SplitFocusRequested", groupId: group.id })}
                    >
                      {/* Close button for non-primary panels */}
                      <Show when={i() > 0}>
                        <div class="absolute top-0 right-0 z-10">
                          <IconButton
                            icon="close-small"
                            variant="ghost"
                            onClick={(e: MouseEvent) => {
                              e.stopPropagation()
                              claxedo.dispatch({ type: "SplitGroupCloseRequested", groupId: group.id })
                            }}
                            aria-label="Close panel"
                            class="opacity-60 hover:opacity-100"
                          />
                        </div>
                      </Show>
                      <GroupPanel
                        groupId={group.id}
                        isPrimary={i() === 0}
                        props={props}
                        workspaceBarProjects={workspaceBarProjects}
                        worktreeInfo={worktreeInfo}
                        sidebarPinned={sidebarPinned}
                        mobileSidebarOpen={mobileSidebarOpen}
                        toggleMobileSidebar={toggleMobileSidebar}
                        allProjects={props.projects}
                        visibleWorkspaces={visibleWorkspaces()}
                        onToggleWorkspace={toggleWorkspaceVisibility}
                        trafficLightPad={trafficLightPad}
                      />
                    </div>
                  </>
                )}
              </For>
            </div>
          </SharedTabDragDrop>

          {/* Mount route content (DirectoryLayout + providers) without rendering it visually.
              Session content is rendered by GroupContentRenderer via DirectoryScope (session.tsx
              bails out early here). */}
          <div class="hidden">{props.children}</div>
        </div>
      </div>
    </div>
  )
}

function RailLayoutInner(props: RailLayoutProps) {
  try {
    useClaxedoLayout()
    return <RailLayoutBody {...props} />
  } catch {
    return (
      <ClaxedoLayoutProvider>
        <RailLayoutBody {...props} />
      </ClaxedoLayoutProvider>
    )
  }
}

/**
 * Rail Layout Inner (without provider)
 *
 * Use this when you need to provide your own ClaxedoLayoutProvider.
 */
export { RailLayoutInner }

/**
 * Rail Layout with provider
 *
 * Use this component at the top level to enable Claxedo layout mode.
 */
export function RailLayout(props: RailLayoutProps) {
  return (
    <ClaxedoLayoutProvider>
      <RailLayoutInner {...props} />
    </ClaxedoLayoutProvider>
  )
}

/**
 * Hook to check if Claxedo layout is enabled
 */
export function useClaxedoEnabled() {
  try {
    const claxedo = useClaxedoLayout()
    return createMemo(() => claxedo.enabled())
  } catch {
    // Context not available, Claxedo not enabled
    return () => false
  }
}
