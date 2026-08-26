import { createAsyncState } from "@/lib/async-state"
import { Loading, Match, Show, Switch, createEffect, createMemo, createSignal, untrack, type Accessor } from "solid-js"
import { usePlatform } from "@/platform/runtime/platform-provider"

import { useClaxedoState } from "../state/index"
import { SessionPaneScope } from "../../../features/session/ui/components/session-pane-scope"
import { ProcessPaneProvider } from "../context/process-pane"
import { useProcessPane } from "../context/process-pane"
import { WorkspaceFilesNavigator } from "../workspace-panel/files-navigator"
import { WorkspaceProcessesNavigator } from "@/features/processes/ui"
import type {
  WorkspacePanelFocus,
  WorkspacePanelMode,
  WorkspacePanelState,
} from "../../../features/workspaces/ui/panel/workspace-panel-state"
import { loadTerminalSessionPreview } from "../../../features/terminal/lib/terminal-session-preview"
import { getClaxedoServerUrl } from "@/platform/api/api"
import { reviewRegionPolicy } from "../../review/review-region-policy"
import { isWorkspaceReady, workspaceOffline } from "../../../features/workspaces/data/workspace-connection"
import {
  reviewWorkspaceWorkingSetKey,
  type ReviewWorkspaceWorkingSetSnapshot,
} from "../review/review-workspace-working-set"
import type { ReviewVcsDirectory } from "@/features/review/ui/review-vcs-cache"
import { createPathHelpers } from "@/platform/files/path"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { resolveWorkspaceRuntime } from "@/platform/runtime/workspace-runtime-record"
import { useSettings } from "@/platform/settings/provider"
import { ReviewWorkspace } from "./workspace-panel-review-load"

const PANEL_NAVIGATOR_TRANSITION = "transform 120ms cubic-bezier(0.2, 0, 0, 1), width 120ms cubic-bezier(0.2, 0, 0, 1)"

/**
 * The last focus request ReviewWorkspace acted on, keyed by the live panel
 * state (one per provider, so parallel providers and tests never share
 * consumption). It lives at module scope because the panel body is disposed to
 * zero on close while the slice keeps `focus`; without this record, a reopen
 * would replay the old focus request and override the active tab the working
 * set just restored. The full request (version + kind + target) is recorded —
 * not a bare version high-water mark — because the slice's version counter
 * restarts once focus is cleared, so only an exact match proves a replay.
 */
type ConsumedPanelFocus = { version: number; kind: WorkspacePanelFocus["kind"]; target: string }
const consumedPanelFocus = new WeakMap<WorkspacePanelState, ConsumedPanelFocus>()

function panelFocusTarget(value: WorkspacePanelFocus) {
  switch (value.kind) {
    case "review":
      return "review"
    case "file":
      return value.path
    case "browser":
      return value.url
    case "process":
      return value.processId
    case "context":
      return value.sessionId
  }
}

function isConsumedPanelFocus(value: WorkspacePanelFocus, consumed: ConsumedPanelFocus | undefined) {
  return (
    !!consumed &&
    consumed.version === value.version &&
    consumed.kind === value.kind &&
    consumed.target === panelFocusTarget(value)
  )
}
/** The only review target this panel mounts today; see `reviewWorkspaceKey`. */
export const PANEL_REVIEW_MODE = "uncommitted" as const

/**
 * Identity of the retained working set for this panel's review target — the
 * one key the body's load/store and the rail's click-time prefetch resolve,
 * so a warm-up and the mounted surface can never disagree on the entry.
 */
export function panelReviewWorkingSetKey(input: ReviewVcsDirectory) {
  return reviewWorkspaceWorkingSetKey({
    serverUrl: getClaxedoServerUrl(),
    workspaceId: sessionWorkspaceRuntimeRef({ directory: input.directory })?.workspaceId,
    workspaceDir: input.directory,
    mode: PANEL_REVIEW_MODE,
  })
}

/**
 * The file path the working set's active tab points at, if the active tab is
 * a file tab. The files navigator restores its selection from this on reopen:
 * a consumed focus request is no longer replayed (it used to double as the
 * selection source), so the retained working set is the selection's owner.
 */
export function workingSetActiveFilePath(
  snapshot: ReviewWorkspaceWorkingSetSnapshot | undefined,
  pathFromTab: (tabId: string) => string | undefined,
) {
  if (!snapshot) return undefined
  const active = snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId)
  if (!active || active.kind !== "file") return undefined
  return pathFromTab(active.tabId) ?? active.tabId
}
function ProcessesNavigator(props: {
  directory: Parameters<typeof WorkspaceProcessesNavigator>[0]["directory"]
  activeProcessId?: string
  onProcessSelect: (processId: string) => void
}) {
  const processPane = useProcessPane()
  const platform = usePlatform()
  return <WorkspaceProcessesNavigator {...props} processPane={processPane} request={platform.fetch} />
}

export function WorkspacePanelBody(props: {
  mode: WorkspacePanelMode
  state: WorkspacePanelState
  /**
   * The one workspace directory this body owns, pinned by the caller at
   * construction. The panel keys the body on it, so a change means a new body.
   */
  directory?: string
  /** Whether this retained panel body is actually visible to the user. */
  active: Accessor<boolean>
  /**
   * The panel's second construction chunk. The review surface is the whole
   * cost of building this body, so it is what the chunk boundary separates:
   * this mount waits for the yielded frame the panel schedules, and a close or
   * a switch away in between cancels it.
   */
  hydrated: Accessor<boolean>
  /**
   * Workspace directory of the pane the workbench currently focuses. It leads
   * the panel slice by one flush: the focused pane moves first, and the panel
   * retargets from an effect afterwards. That gap is what `ownsFocusedPane`
   * below reads.
   */
  focusedWorkspaceDir: Accessor<string | undefined>
}) {
  const claxedoState = useClaxedoState()
  const platform = usePlatform()
  const panelState = () => claxedoState.workspacePanel.state()
  // One mount, one directory, one construction. Reading the live slice here
  // gave directory identity two owners: the outgoing body's keyed `Show` below
  // rebuilt the whole destination subtree during the update phase of the
  // retarget flush, moments before the panel disposed that body and built the
  // destination a second time.
  const directory = () => props.directory
  // BUG-2: The session connecting gate (pages/session.tsx) only wraps the center
  // pane. The Review panel lives here in ClaxedoLayout and would otherwise mount
  // ReviewWorkspace ("Loading review...") against a relay-backed runtime that is not
  // connected yet, or one the caller cannot reach (403). Gate the Review mount on
  // workspace-readiness using the same workspace-relay-connection signal the
  // session gate relies on. The sidebar session LIST stays live (central data);
  // only the runtime-dependent Review surface waits.
  const reviewWorkspaceId = () => {
    const dir = directory()
    return dir ? sessionWorkspaceRuntimeRef({ directory: dir })?.workspaceId : undefined
  }
  const workspaceReady = () => {
    const workspaceId = reviewWorkspaceId()
    if (!workspaceId) return true
    return isWorkspaceReady(workspaceId)
  }
  // Only a NEW focus request may steer the panel: a replayed unchanged one
  // (kept by the slice across close) must not override the active tab restored
  // from the working set. The stale request is fixed at mount so consumption
  // during THIS mount never retracts a focus the lazily loaded ReviewWorkspace
  // has yet to read.
  const staleFocus = consumedPanelFocus.get(panelState())
  const focus = () => {
    const value = panelState().focus
    if (!value || isConsumedPanelFocus(value, staleFocus)) return undefined
    // A focus request belongs to ONE workspace, and this body owns exactly one.
    // The panel retains a recently-visited body beside the one it shows, and
    // both read the same live slice; without this, the retained body would
    // consume — through the shared `consumedPanelFocus` record — a request
    // aimed at the workspace the user just switched to, and the destination
    // would mount already believing that request had been served.
    //
    // The test is the SLICE'S workspace against this body's pinned one, not
    // this body's displayed-ness: displayed-ness is derived from the very
    // slice a focus request steers, so subscribing the focus chain to it closes
    // a circle in the update graph (it recursed `runUpdates` without bound on
    // the first cross-workspace switch). The workspace comparison reads only
    // the slice this function already depends on.
    if (panelState().workspaceDir !== directory()) return undefined
    return value
  }
  const consumeFocus = () => {
    const panel = panelState()
    const value = panel.focus
    if (!value) return
    consumedPanelFocus.set(panel, {
      version: value.version,
      kind: value.kind,
      target: panelFocusTarget(value),
    })
    // A focus request is a one-shot command, not retained panel state. Clear it
    // once the real ReviewWorkspace acts on it so a later top-level reopen can
    // intentionally select Review. If the panel closes before this runs, the
    // request remains and is delivered to the next mount.
    claxedoState.workspacePanel.retarget({
      workspaceDir: panel.workspaceDir,
      targetPaneId: panel.targetPaneId,
      focus: null,
    })
  }
  const focusPath = () => {
    const value = focus()
    return value?.kind === "file" ? value.path : undefined
  }
  const focusReviewVersion = () => {
    const value = focus()
    return value?.kind === "review" ? value.version : 0
  }
  const focusVersion = () => {
    const value = focus()
    return value?.kind === "file" ? value.version : 0
  }
  const focusFileIntent = () => {
    const value = focus()
    return value?.kind === "file" ? value.intent : undefined
  }
  const focusLine = () => {
    const value = focus()
    return value?.kind === "file" ? value.line : undefined
  }
  const focusProcessId = () => {
    const value = focus()
    return value?.kind === "process" ? value.processId : undefined
  }
  const focusProcessVersion = () => {
    const value = focus()
    return value?.kind === "process" ? value.version : 0
  }
  const focusContextSessionId = () => {
    const value = focus()
    return value?.kind === "context" ? value.sessionId : undefined
  }
  const focusContextVersion = () => {
    const value = focus()
    return value?.kind === "context" ? value.version : 0
  }
  const focusBrowserUrl = () => {
    const value = focus()
    return value?.kind === "browser" ? value.url : undefined
  }
  const focusBrowserVersion = () => {
    const value = focus()
    return value?.kind === "browser" ? value.version : 0
  }
  const activeSurfaceId = () => claxedoState.wb.selectors.focusedContent() ?? undefined
  const activeSurface = () => {
    const target = targetContentId()
    return target ? claxedoState.meta.get(target) : undefined
  }
  const targetPaneId = () => panelState().targetPaneId ?? claxedoState.wb.state.focusedPaneId ?? undefined
  /**
   * Whether the focused pane still belongs to the workspace this body was
   * built for. On a cross-workspace session click it does not: the workbench
   * points the pane at the new session during the update phase, and the panel
   * retargets — disposing this body — only in the effect phase that follows.
   */
  const ownsFocusedPane = () => {
    const focused = props.focusedWorkspaceDir()
    return !focused || focused === directory()
  }
  // Holds its last in-scope value while the focused pane has already moved to
  // another workspace. This body is being replaced by one built for that
  // workspace; projecting the incoming session into the review still mounted
  // here would re-render the OUTGOING workspace's whole corpus, inside the
  // click task, for a surface the user will never see.
  const targetContentId = createMemo<string | undefined>((previous) => {
    if (!ownsFocusedPane()) return previous
    const paneId = panelState().targetPaneId ?? claxedoState.wb.state.focusedPaneId
    const paneContent = paneId ? claxedoState.wb.state.panes.find((pane) => pane.id === paneId)?.contentId : undefined
    return paneContent ?? activeSurfaceId()
  })
  const targetContent = () => {
    const target = targetContentId()
    if (!target) return
    return claxedoState.meta.get(target)
  }
  const targetTerminalId = () => {
    if (!props.active()) return
    const content = targetContent()
    if (content?.type === "terminal") return content.terminalId
    const surface = activeSurface()
    if (surface?.type === "terminal") return surface.terminalId
    return
  }
  const targetTerminalSession = createAsyncState(async () => {
    const terminalId = targetTerminalId()
    if (!terminalId) return undefined
    return loadTerminalSessionPreview(getClaxedoServerUrl(), terminalId, {
      request: platform.fetch,
      directory: directory(),
      resolveWorkspaceRuntime: async ({ directory }) => {
        const workspace = await resolveWorkspaceRuntime({
          baseUrl: getClaxedoServerUrl(),
          request: platform.fetch,
          directory,
        })
        if (!workspace?.kind) return null
        return {
          kind: workspace.kind,
          workspaceId: workspace.workspaceId,
        }
      },
    })
  })
  const targetSessionId = () => {
    const content = targetContent()
    if (content?.type === "session" || content?.type === "context") return content.sessionId
    if (content?.type === "terminal") return targetTerminalSession.data()?.sessionId ?? undefined
    const surface = activeSurface()
    if (surface?.type === "terminal") return targetTerminalSession.data()?.sessionId ?? undefined
    return surface?.sessionId
  }
  const sessionRef = () => targetContent()?.content?.sessionRef ?? activeSurface()?.content?.sessionRef
  // A retained body owns a frozen projection of the global panel navigator.
  // Only the displayed body samples the live slice: otherwise changing a
  // navigator in workspace B also mutates workspace A's inert DOM and can
  // construct an expensive hidden navigator inside the user's B interaction.
  // Reactivation catches up from the authoritative slice in the same flush.
  const panelNavigator = createMemo<WorkspacePanelState["navigator"]>((previous) =>
    props.active() ? panelState().navigator : previous
  )
  const filesNavigatorSelected = () => panelNavigator() === "files" || panelNavigator() === "changes"
  const filesNavigatorActive = () => props.active() && filesNavigatorSelected()
  const settings = useSettings()
  const navigatorSide = () => settings.appearance.navigatorSide()
  const processesNavigatorSelected = () => panelNavigator() === "processes"
  const [filesNavigatorVisited, setFilesNavigatorVisited] = createSignal(untrack(filesNavigatorSelected))
  const [processesNavigatorVisited, setProcessesNavigatorVisited] = createSignal(untrack(processesNavigatorSelected))
  const [filesNavigatorMode, setFilesNavigatorMode] = createSignal<"files" | "changes">(
    untrack(panelNavigator) === "changes" ? "changes" : "files",
  )
  const reviewWorkspaceKey = createMemo(() => {
    const dir = directory()
    if (!dir) return
    return [dir, PANEL_REVIEW_MODE].join("\n")
  })
  // Identity of the retained working set this mount owns. Derived from the
  // workspace and its runtime, never from the session: switching sessions inside
  // one workspace keeps the same review tabs and scroll.
  const reviewWorkingSetKey = createMemo(() => {
    const dir = directory()
    if (!dir) return
    // reviewWorkspaceId() keeps this memo reactive to runtime signing.
    reviewWorkspaceId()
    return panelReviewWorkingSetKey({ directory: dir })
  })
  const reviewWorkingSet = claxedoState.workspacePanel.reviewWorkingSet
  const loadWorkingSet = () => {
    const key = reviewWorkingSetKey()
    return key ? reviewWorkingSet.get(key) : undefined
  }
  const pathHelpers = createMemo(() => createPathHelpers(() => directory() ?? ""))
  const [activeWorkingFilePath, setActiveWorkingFilePath] = createSignal(
    untrack(() => workingSetActiveFilePath(loadWorkingSet(), (tabId) => pathHelpers().pathFromTab(tabId))),
  )
  const storeWorkingSet = (snapshot: Parameters<typeof reviewWorkingSet.set>[1]) => {
    const key = reviewWorkingSetKey()
    if (key) reviewWorkingSet.set(key, snapshot)
    setActiveWorkingFilePath(workingSetActiveFilePath(snapshot, (tabId) => pathHelpers().pathFromTab(tabId)))
  }
  // Latched, not derived: once this mount has built the review surface it
  // keeps it for the life of the body (see `reviewSurfaceMounted`), so a later
  // chunk-door change cannot tear it back down.
  const [reviewWorkspaceMountedKey, setReviewWorkspaceMountedKey] = createSignal<string | undefined>()
  const reviewArmed = createMemo((prev: ReturnType<typeof reviewRegionPolicy> | undefined) =>
    reviewRegionPolicy({ key: reviewWorkspaceKey(), prev, ready: workspaceReady() }),
  )

  createEffect(
    () => ({ navigator: panelNavigator(), targeted: Boolean(panelState().workspaceDir && panelState().mode) }),
    ({ navigator, targeted }) => {
      if (targeted) setFilesNavigatorVisited(true)
      if (navigator === "files" || navigator === "changes") {
        setFilesNavigatorMode(navigator)
        setFilesNavigatorVisited(true)
        return
      }
      if (navigator === "processes") setProcessesNavigatorVisited(true)
    },
  )

  // Two-phase form of the hydration door: the compute tracks the review key
  // and the chunk door, and the apply phase latches the mounted key untracked
  // (this effect is the only writer, so tracking the latch fed it its write).
  createEffect(
    () => ({ key: reviewWorkspaceKey(), hydrated: props.hydrated() }),
    ({ key, hydrated }) => {
      if (!key || !hydrated) return
      setReviewWorkspaceMountedKey(key)
    },
  )

  return (
    <Show
      keyed
      when={directory()}
      fallback={
        <div class="flex h-full items-center justify-center px-6 text-center text-compact text-text-weak">
          Select a workspace to use this panel.
        </div>
      }
    >
      {(dir) => (
        <SessionPaneScope
          directory={dir}
          sessionRef={sessionRef}
          active={() => props.active() && !!panelState().mode}
          sessionId={targetSessionId}
          paneId={() => targetPaneId() ?? ""}
          surfaceId={targetContentId}
          suppressConnectionGate
        >
          <ProcessPaneProvider>
            <div class="flex h-full min-h-0 flex-col">
              <div class="min-h-0 flex-1 overflow-hidden">
                <Switch>
                  <Match when={true}>
                    <Show when={targetSessionId() ?? "new"}>
                      {(sessionId) => (
                        <div
                          class="relative flex size-full min-w-0 overflow-hidden"
                          data-workspace-panel-session-id={targetSessionId() ?? ""}
                          data-workspace-panel-content-id={targetContentId() ?? ""}
                          data-review-workspace-id={reviewWorkspaceId() ?? ""}
                          data-review-workspace-ready={workspaceReady() ? "true" : "false"}
                        >
                          {/* Inline navigator column (not an overlay): the tree
                            sits beside the tab content instead of sliding over
                            the file the user just opened. Collapse animates
                            width; the column docks per the appearance setting. */}
                          <Show when={filesNavigatorVisited()}>
                            <div
                              data-testid="workspace-navigator-overlay"
                              data-navigator="files"
                              data-open={filesNavigatorSelected() ? "true" : "false"}
                              aria-hidden={
                                (filesNavigatorSelected() ? undefined : "true") == null
                                  ? undefined
                                  : (filesNavigatorSelected() ? undefined : "true")
                                    ? "true"
                                    : "false"
                              }
                              class={[
                                "claxedo-workspace-navigator-overlay h-full shrink-0 overflow-hidden bg-background-base motion-reduce:transition-none",
                                {
                                  "pointer-events-none": !filesNavigatorSelected(),
                                  "order-first border-r border-border-weak-base": navigatorSide() === "left",
                                  "order-last border-l border-border-weak-base": navigatorSide() === "right",
                                  "border-transparent": !filesNavigatorSelected(),
                                },
                              ]}
                              style={{
                                width: filesNavigatorSelected() ? "min(280px, 45%)" : "0px",
                                transition: PANEL_NAVIGATOR_TRANSITION,
                                "content-visibility": filesNavigatorSelected() ? "visible" : "hidden",
                              }}
                            >
                              <div class="h-full w-[min(280px,45cqw)] min-w-[220px]">
                                <WorkspaceFilesNavigator
                                  mode={filesNavigatorMode()}
                                  active={filesNavigatorActive()}
                                  activePath={focusPath() ?? activeWorkingFilePath()}
                                  onFileClick={(path, intent) =>
                                    claxedoState.workspacePanel.retarget({
                                      workspaceDir: dir,
                                      targetPaneId: targetPaneId(),
                                      focus: { kind: "file", path, intent },
                                    })
                                  }
                                />
                              </div>
                            </div>
                          </Show>
                          {reviewWorkspaceMountedKey() === reviewWorkspaceKey() && reviewArmed().armed ? (
                            <div
                              class="h-full min-w-0 flex-1"
                              style={{ visibility: workspaceReady() ? "visible" : "hidden" }}
                            >
                              <Loading fallback={<div class="size-full bg-background-base" />}>
                                <ReviewWorkspace
                                  class="h-full"
                                  directory={dir}
                                  sessionId={sessionId()}
                                  mode={PANEL_REVIEW_MODE}
                                  initialWorkingSet={loadWorkingSet()}
                                  onWorkingSetChange={storeWorkingSet}
                                  focusReviewVersion={focusReviewVersion()}
                                  focusPath={focusPath()}
                                  focusVersion={focusVersion()}
                                  focusFileIntent={focusFileIntent()}
                                  focusLine={focusLine()}
                                  focusProcessId={focusProcessId()}
                                  focusProcessVersion={focusProcessVersion()}
                                  focusContextSessionId={focusContextSessionId()}
                                  focusContextVersion={focusContextVersion()}
                                  focusBrowserUrl={focusBrowserUrl()}
                                  focusBrowserVersion={focusBrowserVersion()}
                                  onFocusConsumed={consumeFocus}
                                  active={props.active()}
                                />
                              </Loading>
                            </div>
                          ) : null}
                          <Show
                            when={reviewWorkspaceMountedKey() === reviewWorkspaceKey() && reviewArmed().showPending}
                          >
                            <div
                              data-testid="workspace-review-pending"
                              class="absolute inset-0 z-10 flex min-w-0 items-center justify-center bg-background-base px-6 text-center text-compact text-text-weak"
                            >
                              <Show
                                when={!workspaceOffline(reviewWorkspaceId())}
                                fallback={<span>This workspace isn't available.</span>}
                              >
                                <span>Connecting to workspace...</span>
                              </Show>
                            </div>
                          </Show>
                          <Show when={processesNavigatorVisited()}>
                            <div
                              data-testid="workspace-navigator-overlay"
                              data-navigator="processes"
                              data-open={processesNavigatorSelected() ? "true" : "false"}
                              aria-hidden={
                                (processesNavigatorSelected() ? undefined : "true") == null
                                  ? undefined
                                  : (processesNavigatorSelected() ? undefined : "true")
                                    ? "true"
                                    : "false"
                              }
                              class={[
                                "claxedo-workspace-navigator-overlay h-full shrink-0 overflow-hidden bg-background-base motion-reduce:transition-none",
                                {
                                  "pointer-events-none": !processesNavigatorSelected(),
                                  "order-first border-r border-border-weak-base": navigatorSide() === "left",
                                  "order-last border-l border-border-weak-base": navigatorSide() === "right",
                                  "border-transparent": !processesNavigatorSelected(),
                                },
                              ]}
                              style={{
                                width: processesNavigatorSelected() ? "min(280px, 45%)" : "0px",
                                transition: PANEL_NAVIGATOR_TRANSITION,
                                "content-visibility": processesNavigatorSelected() ? "visible" : "hidden",
                              }}
                            >
                              <div class="h-full w-[min(280px,45cqw)] min-w-[220px]">
                                <ProcessesNavigator
                                  directory={dir}
                                  activeProcessId={focusProcessId()}
                                  onProcessSelect={(processId) =>
                                    claxedoState.workspacePanel.retarget({
                                      workspaceDir: dir,
                                      targetPaneId: targetPaneId(),
                                      navigator: "processes",
                                      focus: { kind: "process", processId },
                                    })
                                  }
                                />
                              </div>
                            </div>
                          </Show>
                        </div>
                      )}
                    </Show>
                  </Match>
                </Switch>
              </div>
            </div>
          </ProcessPaneProvider>
        </SessionPaneScope>
      )}
    </Show>
  )
}
