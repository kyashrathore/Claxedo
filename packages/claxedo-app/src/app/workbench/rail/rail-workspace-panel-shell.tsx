import { createEffect, onCleanup, type Accessor } from "solid-js"

import { WorkspacePanel } from "../../../features/workspaces/ui/panel/workspace-panel"
import {
  isGlobalPanelMode,
  type WorkspacePanelMode,
  type WorkspacePanelNavigator,
  type WorkspacePanelPaneTarget,
} from "../../../features/workspaces/ui/panel/workspace-panel-state"
import { setWorkGraphPanelBodySlot, setWorkGraphPanelHeaderSlot } from "@/ui/controls/portal-slot"
import { getClaxedoServerUrl } from "@/platform/api/api"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { useSDK } from "@/features/review/app-ports"
import { createReviewDiffClient, fetchReviewVcsDiffSummary } from "@/features/review/ui/review-vcs-load"
import type { useClaxedoState } from "../state/index"
import { WorkspacePanelChrome, WorkspacePanelHeader } from "./workbench-shell-header"
import { PANEL_REVIEW_MODE, panelReviewWorkingSetKey, WorkspacePanelBody } from "./workspace-panel-body"

type RailWorkspacePanelState = ReturnType<typeof useClaxedoState>

// Compact resting width for the global WorkGraph panel — a "Needs you" / Settings
// list does not need the 70% review default. The user can still drag to resize.
const WORKGRAPH_PANEL_WIDTH = 420

export function RailWorkspacePanelShell(props: {
  state: RailWorkspacePanelState
  focusedPanelTarget: () => WorkspacePanelPaneTarget | undefined
  hasWorkspacePanelTarget: () => boolean
  onPanelShellRef: (element: HTMLElement | undefined) => void
  onRestingWidthChange: (width: number) => void
  onToggleWorkspacePanelFullWidth: () => void
  toggleFocusedWorkspaceNavigator: (navigator: WorkspacePanelNavigator) => void
  toggleFocusedWorkspaceReview: (button: HTMLButtonElement) => void
  visualOpen: Accessor<boolean>
  workspacePanelForFocusedTarget: () => boolean
  workspacePanelFullWidth: Accessor<boolean>
  workspacePanelMode: () => string | undefined
  workspacePanelNavigator: () => WorkspacePanelNavigator | null | undefined
}) {
  const globalMode = () => isGlobalPanelMode(props.state.workspacePanel.state().mode as WorkspacePanelMode | undefined)
  const platform = usePlatform()
  // Data starts at the click: the moment the panel state opens toward a
  // workspace surface, warm the review corpus cache the settle-deferred
  // content will read, so the fetch overlaps the shell motion instead of
  // starting after it. Same loader and cache key as the mounted surface, so
  // the surface's own load dedupes against this warm-up.
  let prefetchedDir: string | undefined
  createEffect(() => {
    const state = props.state.workspacePanel.state()
    if (!state.open || !state.mode || isGlobalPanelMode(state.mode as WorkspacePanelMode | undefined)) {
      prefetchedDir = undefined
      return
    }
    const dir = state.workspaceDir
    if (!dir || prefetchedDir === dir) return
    prefetchedDir = dir
    // Lazy port access: the warm-up is an optimization and must not couple
    // the shell to review port configuration (headless shells, tests).
    let workspace: ReturnType<NonNullable<ReturnType<typeof useSDK>["workspace"]>> | undefined
    try {
      workspace = useSDK().workspace?.(dir)
    } catch {
      workspace = undefined
    }
    const key = panelReviewWorkingSetKey({ directory: dir })
    const retained = key ? props.state.workspacePanel.reviewWorkingSet.get(key)?.review : undefined
    const mode = retained?.mode ?? PANEL_REVIEW_MODE
    const toFrom = mode === "to-from"
    const client = createReviewDiffClient({
      serverUrl: getClaxedoServerUrl(),
      directory: dir,
      request: platform.fetch,
      workspaceId: workspace?.workspaceId,
      workspace,
    })
    void fetchReviewVcsDiffSummary({
      client,
      directory: dir,
      mode,
      fromRef: toFrom ? retained?.fromRef?.trim() || undefined : undefined,
      toRef: toFrom ? retained?.toRef?.trim() || undefined : undefined,
    }).catch(() => {})
  })
  return (
    <WorkspacePanel
      state={props.state.workspacePanel.state()}
      visualOpen={props.visualOpen}
      fullWidth={props.workspacePanelFullWidth}
      preferredWidth={() => (globalMode() ? WORKGRAPH_PANEL_WIDTH : undefined)}
      onRestingWidthChange={props.onRestingWidthChange}
      onShellRef={props.onPanelShellRef}
      onModeSelect={(mode) => props.state.workspacePanel.select(mode)}
      contentIdentity={(state) => ({
        family: isGlobalPanelMode(state.mode) ? "global" : "workspace",
        activitySubject: state.activitySubject,
        workspaceDir: state.workspaceDir,
      })}
      onClose={() => {
        props.state.workspacePanel.close()
      }}
      renderHeader={(state) =>
        isGlobalPanelMode(state.mode) ? (
          <GlobalPanelHeader
            workspacePanelOpen={props.visualOpen}
            workspacePanelFullWidth={props.workspacePanelFullWidth}
            onToggleFullWidth={props.onToggleWorkspacePanelFullWidth}
            onTogglePanel={props.toggleFocusedWorkspaceReview}
          />
        ) : (
          <WorkspacePanelHeader
            focusedPanelTarget={props.focusedPanelTarget}
            hasWorkspacePanelTarget={props.hasWorkspacePanelTarget}
            workspacePanelForFocusedTarget={props.workspacePanelForFocusedTarget}
            workspacePanelNavigator={props.workspacePanelNavigator}
            workspacePanelMode={props.workspacePanelMode}
            toggleFocusedWorkspaceNavigator={props.toggleFocusedWorkspaceNavigator}
            workspacePanelOpen={props.visualOpen}
            workspacePanelFullWidth={props.workspacePanelFullWidth}
            onToggleFullWidth={props.onToggleWorkspacePanelFullWidth}
            onTogglePanel={props.toggleFocusedWorkspaceReview}
          />
        )
      }
      renderMode={(mode, state) => {
        if (isGlobalPanelMode(mode)) return <GlobalPanelBodyMount />
        // Pinned, deliberately: `contentIdentity` above keys the body on the
        // workspace directory, so every change to it disposes this body and
        // builds a new one. `state` is the live slice — it moves to the next
        // workspace one flush BEFORE that disposal — so reading the directory
        // off it inside the body would have the outgoing body rebuild its whole
        // subtree for a workspace it is about to hand over.
        const directory = state.workspaceDir
        return (
          <WorkspacePanelBody
            mode={mode}
            state={state}
            directory={directory}
            active={props.visualOpen}
            focusedWorkspaceDir={() => props.focusedPanelTarget()?.workspaceDir}
          />
        )
      }}
    />
  )
}

/**
 * Header for a global-navigation panel mode. Reuses the exact top-level
 * `WorkspacePanelChrome` toggle so there is one physical toggle, and exposes a
 * header portal slot the active global surface fills with its tab controls.
 */
function GlobalPanelHeader(props: {
  workspacePanelOpen: () => boolean
  workspacePanelFullWidth: () => boolean
  onToggleFullWidth: () => void
  onTogglePanel: (button: HTMLButtonElement) => void
}) {
  onCleanup(() => setWorkGraphPanelHeaderSlot(null))
  return (
    <div class="shrink-0 bg-background-base">
      <div
        data-testid="workgraph-panel-l1-header"
        class="relative flex h-9 shrink-0 items-center gap-2 overflow-hidden border-b border-border-weaker-base bg-background-base pl-2"
      >
        <div
          ref={(el) => setWorkGraphPanelHeaderSlot(el)}
          data-testid="workgraph-panel-header-slot"
          class="flex h-full min-w-0 flex-1 items-center overflow-hidden"
        />
        <div class="flex h-full shrink-0 items-center pr-1">
          <WorkspacePanelChrome
            workspacePanelOpen={props.workspacePanelOpen}
            workspacePanelFullWidth={props.workspacePanelFullWidth}
            onToggleFullWidth={props.onToggleFullWidth}
            onTogglePanel={props.onTogglePanel}
          />
        </div>
      </div>
    </div>
  )
}

function GlobalPanelBodyMount() {
  onCleanup(() => setWorkGraphPanelBodySlot(null))
  return (
    <div
      ref={(el) => setWorkGraphPanelBodySlot(el)}
      data-testid="workgraph-panel-body-slot"
      class="flex size-full min-h-0 flex-col"
    />
  )
}
