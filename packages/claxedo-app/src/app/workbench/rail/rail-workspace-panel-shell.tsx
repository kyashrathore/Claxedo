import { createEffect, onCleanup, type Accessor } from "solid-js"

import { WorkspacePanel } from "../../../features/workspaces/ui/panel/workspace-panel"
import type { ShellSettleMotion } from "../../../features/workspaces/ui/panel/workspace-panel-shell-settle"
import type {
  WorkspacePanelNavigator,
  WorkspacePanelPaneTarget,
} from "../../../features/workspaces/ui/panel/workspace-panel-state"
import { getClaxedoServerUrl } from "@/platform/api/api"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { useSDK } from "@/features/review/app-ports"
import { createReviewDiffClient, fetchReviewVcsDiffSummary } from "@/features/review/ui/review-vcs-load"
import type { useClaxedoState } from "../state/index"
import { WorkspacePanelChrome, WorkspacePanelHeader } from "./workbench-shell-header"
import { PANEL_REVIEW_MODE, panelReviewWorkingSetKey, WorkspacePanelBody } from "./workspace-panel-body"
import { warmWorkspacePanelReview } from "./workspace-panel-review-load"

type RailWorkspacePanelState = ReturnType<typeof useClaxedoState>

export function RailWorkspacePanelShell(props: {
  state: RailWorkspacePanelState
  focusedPanelTarget: () => WorkspacePanelPaneTarget | undefined
  hasWorkspacePanelTarget: () => boolean
  onPanelShellRef: (element: HTMLElement | undefined) => void
  /** The workbench column's opening motion, forwarded to the panel's settle gate. */
  openMotion: () => ShellSettleMotion | undefined
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
  const platform = usePlatform()
  // Data AND code start at the click: the moment the panel state opens toward
  // a workspace surface, warm the review corpus cache and the panel body's
  // module graph that the settle-deferred content will read, so both overlap
  // the shell motion instead of starting after it. Same loader and cache key
  // as the mounted surface, and the same `lazy()` wrapper it mounts, so the
  // surface's own load dedupes against this warm-up.
  let prefetchedDir: string | undefined
  createEffect(() => {
    const state = props.state.workspacePanel.state()
    if (!state.open || !state.mode) {
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
    // Code second: the corpus request is the one the rendered surface blocks
    // on, so it claims the connection first; the body's chunks then load
    // alongside it, both finishing well inside the shell's opening motion.
    void warmWorkspacePanelReview()
  })
  return (
    <WorkspacePanel
      state={props.state.workspacePanel.state()}
      visualOpen={props.visualOpen}
      openMotion={props.openMotion}
      fullWidth={props.workspacePanelFullWidth}
      preferredWidth={() => undefined}
      onRestingWidthChange={props.onRestingWidthChange}
      onShellRef={props.onPanelShellRef}
      onModeSelect={(mode) => props.state.workspacePanel.select(mode)}
      contentIdentity={(state) => ({
        family: "workspace",
        activitySubject: state.activitySubject,
        workspaceDir: state.workspaceDir,
      })}
      onClose={() => {
        props.state.workspacePanel.close()
      }}
      renderHeader={() => (
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
      )}
      renderMode={(mode, state, displayed, hydrated) => {
        // Pinned, deliberately: `contentIdentity` above keys the body on the
        // workspace directory, so every change to it hands this body over to a
        // different one. `state` is the live slice — it moves to the next
        // workspace one flush BEFORE that handover — so reading the directory
        // off it inside the body would have the outgoing body rebuild its whole
        // subtree for a workspace it is about to stop showing.
        const directory = state.workspaceDir
        return (
          <WorkspacePanelBody
            mode={mode}
            state={state}
            directory={directory}
            // The panel may hold a recently-visited body beside this one; only
            // the displayed body inside an open panel is the user's surface.
            active={() => props.visualOpen() && displayed()}
            hydrated={hydrated}
            focusedWorkspaceDir={() => props.focusedPanelTarget()?.workspaceDir}
          />
        )
      }}
    />
  )
}
