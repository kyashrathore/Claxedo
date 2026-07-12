import {
  Match,
  Show,
  Suspense,
  Switch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  lazy,
  onCleanup,
} from "solid-js"
import { usePlatform } from "@claxedo/app"

import { useClaxedoState } from "../state/index"
import { SessionPaneScope } from "../../../features/session/ui/components/session-pane-scope"
import { ProcessPaneProvider } from "../context/process-pane"
import { useProcessPane } from "../context/process-pane"
import { WorkspaceFilesNavigator } from "../workspace-panel/files-navigator"
import { WorkspaceProcessesNavigator } from "@/features/processes/ui"
import type { WorkspacePanelMode, WorkspacePanelState } from "../../../features/workspaces/ui/panel/workspace-panel-state"
import { loadTerminalSessionPreview } from "../../../features/terminal/lib/terminal-session-preview"
import { getClaxedoServerUrl } from "@/platform/api/api"
import { reviewRegionPolicy } from "../../review/review-region-policy"
import { isWorkspaceReady, workspaceOffline } from "../../../features/workspaces/data/workspace-connection"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { resolveWorkspaceRuntime } from "@/platform/runtime/cloud/workspace-runtime-store"

const PANEL_NAVIGATOR_TRANSITION = "transform 120ms cubic-bezier(0.2, 0, 0, 1)"
const ReviewWorkspace = lazy(() =>
  import("@/app/workbench/review/review-workspace").then((m) => ({ default: m.ReviewWorkspace })),
)

function ProcessesNavigator(props: {
  directory: Parameters<typeof WorkspaceProcessesNavigator>[0]["directory"]
  activeProcessId?: string
  onProcessSelect: (processId: string) => void
}) {
  const processPane = useProcessPane()
  const platform = usePlatform()
  return (
    <WorkspaceProcessesNavigator
      {...props}
      processPane={processPane}
      request={platform.fetch}
    />
  )
}

export function WorkspacePanelBody(props: {
  mode: WorkspacePanelMode
  state: WorkspacePanelState
}) {
  const claxedoState = useClaxedoState()
  const platform = usePlatform()
  const panelState = () => claxedoState.workspacePanel.state()
  const directory = () => panelState().workspaceDir
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
  const focus = () => panelState().focus
  const focusPath = () => {
    const value = focus()
    return value?.kind === "file" ? value.path : undefined
  }
  const focusVersion = () => {
    const value = focus()
    return value?.kind === "file" ? value.version : 0
  }
  const focusFileIntent = () => {
    const value = focus()
    return value?.kind === "file" ? value.intent : undefined
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
  const activeSurfaceId = () => claxedoState.wb.selectors.focusedContent() ?? undefined
  const activeSurface = () => {
    const target = targetContentId()
    return target ? claxedoState.meta.get(target) : undefined
  }
  const targetPaneId = () => panelState().targetPaneId ?? claxedoState.wb.state.focusedPaneId ?? undefined
  const targetContentId = () => {
    const paneId = panelState().targetPaneId ?? claxedoState.wb.state.focusedPaneId
    const paneContent = paneId
      ? claxedoState.wb.state.panes.find((pane) => pane.id === paneId)?.contentId
      : undefined
    return paneContent ?? activeSurfaceId()
  }
  const targetContent = () => {
    const target = targetContentId()
    if (!target) return
    return claxedoState.meta.get(target)
  }
  const targetTerminalId = () => {
    const content = targetContent()
    if (content?.type === "terminal") return content.terminalId
    const surface = activeSurface()
    if (surface?.type === "terminal") return surface.terminalId
    return
  }
  const [targetTerminalSession] = createResource(targetTerminalId, (terminalId) =>
    loadTerminalSessionPreview(getClaxedoServerUrl(), terminalId, {
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
  )
  const targetSessionId = () => {
    const content = targetContent()
    if (content?.type === "session" || content?.type === "context") return content.sessionId
    if (content?.type === "terminal") return targetTerminalSession()?.sessionId ?? undefined
    const surface = activeSurface()
    if (surface?.type === "terminal") return targetTerminalSession()?.sessionId ?? undefined
    return surface?.sessionId
  }
  const sessionRef = () => targetContent()?.content?.sessionRef ?? activeSurface()?.content?.sessionRef
  const panelNavigator = () => panelState().navigator
  const filesNavigatorActive = () => panelNavigator() === "files" || panelNavigator() === "changes"
  const processesNavigatorActive = () => panelNavigator() === "processes"
  const [filesNavigatorVisited, setFilesNavigatorVisited] = createSignal(filesNavigatorActive())
  const [processesNavigatorVisited, setProcessesNavigatorVisited] = createSignal(processesNavigatorActive())
  const [filesNavigatorMode, setFilesNavigatorMode] = createSignal<"files" | "changes">(
    panelNavigator() === "changes" ? "changes" : "files",
  )
  const reviewWorkspaceKey = createMemo(() => {
    const dir = directory()
    if (!dir) return
    return [dir, "uncommitted"].join("\n")
  })
  const [reviewWorkspaceMountedKey, setReviewWorkspaceMountedKey] = createSignal<string | undefined>(
    filesNavigatorActive() ? undefined : reviewWorkspaceKey(),
  )
  const reviewArmed = createMemo((prev: ReturnType<typeof reviewRegionPolicy> | undefined) =>
    reviewRegionPolicy({ key: reviewWorkspaceKey(), prev, ready: workspaceReady() }))

  createEffect(() => {
    const navigator = panelNavigator()
    if (panelState().workspaceDir && panelState().mode) setFilesNavigatorVisited(true)
    if (navigator === "files" || navigator === "changes") {
      setFilesNavigatorMode(navigator)
      setFilesNavigatorVisited(true)
      return
    }
    if (navigator === "processes") setProcessesNavigatorVisited(true)
  })

  createEffect(() => {
    const key = reviewWorkspaceKey()
    if (!key) return
    if (reviewWorkspaceMountedKey() === key) return
    if (!filesNavigatorActive()) {
      setReviewWorkspaceMountedKey(key)
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => setReviewWorkspaceMountedKey(key), 0)
    })
    onCleanup(() => {
      cancelAnimationFrame(frame)
      if (timer) clearTimeout(timer)
    })
  })

  return (
    <Show
      keyed
      when={directory()}
      fallback={
        <div class="flex h-full items-center justify-center px-6 text-center text-[13px] text-text-weak">
          Select a workspace to use this panel.
        </div>
      }
    >
      {(dir) => (
        <SessionPaneScope
          directory={dir}
          sessionRef={sessionRef}
          active={() => !!panelState().mode}
          sessionId={targetSessionId}
          paneId={() => targetPaneId() ?? ""}
          surfaceId={targetContentId}
          suppressConnectionGate
        >
          <div class="flex h-full min-h-0 flex-col">
            <div class="min-h-0 flex-1 overflow-hidden">
              <Switch>
                <Match when={true}>
                  <Show when={targetSessionId() ?? "new"}>
                    {(sessionId) => (
                      <div
                        class="relative size-full min-w-0 overflow-hidden"
                        data-review-workspace-id={reviewWorkspaceId() ?? ""}
                        data-review-workspace-ready={workspaceReady() ? "true" : "false"}
                      >
                        <Show when={filesNavigatorVisited()}>
                          <div
                            data-testid="workspace-navigator-overlay"
                            data-navigator="files"
                            data-open={filesNavigatorActive() ? "true" : "false"}
                            aria-hidden={filesNavigatorActive() ? undefined : "true"}
                            class="claxedo-workspace-navigator-overlay absolute bottom-0 right-0 top-0 z-20 w-[min(320px,calc(100%-24px))] border-l border-border-weak-base bg-background-base will-change-transform motion-reduce:transition-none"
                            classList={{
                              "pointer-events-none": !filesNavigatorActive(),
                            }}
                            style={{
                              transform: filesNavigatorActive() ? "translate3d(0, 0, 0)" : "translate3d(100%, 0, 0)",
                              transition: PANEL_NAVIGATOR_TRANSITION,
                              "content-visibility": filesNavigatorActive() ? "visible" : "hidden",
                            }}
                          >
                            <WorkspaceFilesNavigator
                              mode={filesNavigatorMode()}
                              active={filesNavigatorActive()}
                              activePath={focusPath()}
                              onFileClick={(path, intent) =>
                                claxedoState.workspacePanel.retarget({
                                  workspaceDir: dir,
                                  targetPaneId: targetPaneId(),
                                  focus: { kind: "file", path, intent },
                                })}
                            />
                          </div>
                        </Show>
                        {reviewWorkspaceMountedKey() === reviewWorkspaceKey() && reviewArmed().armed ? (
                          <div class="size-full min-w-0" style={{ visibility: workspaceReady() ? "visible" : "hidden" }}>
                            <ProcessPaneProvider>
                              <Suspense fallback={<div class="size-full bg-background-base" />}>
                                <ReviewWorkspace
                                  class="h-full"
                                  directory={dir}
                                  sessionId={sessionId()}
                                  mode="uncommitted"
                                  focusPath={focusPath()}
                                  focusVersion={focusVersion()}
                                  focusFileIntent={focusFileIntent()}
                                  focusProcessId={focusProcessId()}
                                  focusProcessVersion={focusProcessVersion()}
                                  focusContextSessionId={focusContextSessionId()}
                                  focusContextVersion={focusContextVersion()}
                                />
                              </Suspense>
                            </ProcessPaneProvider>
                          </div>
                        ) : null}
                        <Show when={reviewWorkspaceMountedKey() === reviewWorkspaceKey() && reviewArmed().showPending}>
                          <div
                            data-testid="workspace-review-pending"
                            class="absolute inset-0 z-10 flex min-w-0 items-center justify-center bg-background-base px-6 text-center text-[13px] text-text-weak"
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
                            data-open={processesNavigatorActive() ? "true" : "false"}
                            aria-hidden={processesNavigatorActive() ? undefined : "true"}
                            class="claxedo-workspace-navigator-overlay absolute bottom-0 right-0 top-0 z-20 w-[min(280px,calc(100%-24px))] border-l border-border-weak-base bg-background-base will-change-transform motion-reduce:transition-none"
                            classList={{
                              "pointer-events-none": !processesNavigatorActive(),
                            }}
                            style={{
                              transform: processesNavigatorActive() ? "translate3d(0, 0, 0)" : "translate3d(100%, 0, 0)",
                              transition: PANEL_NAVIGATOR_TRANSITION,
                              "content-visibility": processesNavigatorActive() ? "visible" : "hidden",
                            }}
                          >
                            <ProcessPaneProvider>
                              <ProcessesNavigator
                                directory={dir}
                                activeProcessId={focusProcessId()}
                                onProcessSelect={(processId) =>
                                  claxedoState.workspacePanel.retarget({
                                    workspaceDir: dir,
                                    targetPaneId: targetPaneId(),
                                    navigator: null,
                                    focus: { kind: "process", processId },
                                  })}
                              />
                            </ProcessPaneProvider>
                          </div>
                        </Show>
                      </div>
                    )}
                  </Show>
                </Match>
              </Switch>
            </div>
          </div>
        </SessionPaneScope>
      )}
    </Show>
  )
}
