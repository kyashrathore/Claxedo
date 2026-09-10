import { Show, createContext, createMemo, useContext, type Accessor, type JSX, type ParentProps } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useShellQueryOptions as useQueryOptions } from "@/features/session/app-ports"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { useGlobalSDK } from "@/features/session/app-ports"
import { useDirectorySessionCacheActions } from "../../data/sync/directory-session-cache"
import { sessionHarness, type SessionRef } from "@/platform/identity/session-ref"
import { harnessSelectionValue } from "@/platform/identity/harness-selection"
import { paneHarnessScope } from "@/features/session/harness/store-policy"
import { usePromptHarnessControllersOptional } from "@/features/session/composer/ui/harness-controller"
import { useWorkspaceScopeRegistryOptional } from "@/features/session/app-ports"
import {
  sessionPaneWorkspaceConnection,
} from "@/platform/runtime/session-workspace"
import { WorkspaceGate } from "@/features/session/app-ports"
import { authFetch } from "@/platform/api/api"
import { PaneIdProvider } from "@/features/session/app-ports"
import { SessionParamsProvider } from "@/features/session/providers/session-params"
import { DirectoryScope } from "@/features/session/app-ports"

/**
 * Whether an enclosing scope already decided this subtree renders no WorkspaceGate.
 * The workspace panel makes that call once for its whole body; a scope nested inside
 * it (a subagent transcript beside the parent turn) is on the same connection and
 * would otherwise draw a second "Connecting to workspace" surface over one region.
 */
const GateSuppressedBySurface = createContext<Accessor<boolean>>(() => false)

export function SessionPaneScope(props: ParentProps<{
  directory: string
  sessionRef?: Accessor<SessionRef | undefined>
  /** Workspace route identity for drafts whose provider directory is still local. */
  workspaceId?: Accessor<string | undefined>
  harnessType?: Accessor<string | undefined>
  active?: Accessor<boolean>
  sessionId?: Accessor<string | undefined>
  paneId?: Accessor<string | undefined>
  surfaceId?: Accessor<string | undefined>
  leafId?: Accessor<string | undefined>
  onNavigateToSession?: (sessionID: string) => void
  onSessionHref?: (sessionID: string) => string
  onSyncSession?: (sessionID: string) => void | Promise<void>
  connectionFallback?: JSX.Element
  // The workspace PANEL (right rail) must NOT render its OWN connecting/offline
  // "Connecting to workspace" / "Workspace failed to start" surface — that state
  // is owned by the SINGLE main-content WorkspaceGate. When this is set, the pane
  // skips WorkspaceGate entirely. The panel body owns any mode-specific
  // readiness chrome (Review keeps a warm subtree plus pending overlay), while
  // the main content gate remains the only full workspace startup/offline view.
  suppressConnectionGate?: boolean
}>) {
  const gateSuppressedBySurface = useContext(GateSuppressedBySurface)
  const gateSuppressed = createMemo(() => !!props.suppressConnectionGate || gateSuppressedBySurface())
  const workspaceScopes = useWorkspaceScopeRegistryOptional()
  const directorySessionCacheActions = useDirectorySessionCacheActions()
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  // The signed project inventory carries each relay-backed workspace's REAL kind
  // (cloud vs user-hosted). Threaded into the connection resolver so the gate
  // drives the CORRECT readiness signal — mint+health for user-hosted, not the
  // cloud `resolveWorkspaceRuntime` path that throws "Workspace runtime is
  // unavailable" for a user-hosted workspace whose mint actually returns 200.
  const queryOptions = useQueryOptions()
  const projectsQuery = useQuery(() => queryOptions.projects())
  const projects = createMemo(() => projectsQuery.data ?? [])
  const sessionId = createMemo(() => props.sessionRef?.()?.sessionId ?? props.sessionId?.())
  const harnessControllers = usePromptHarnessControllersOptional()
  // A session ref names the harness when it carries one (a remote session's
  // identity). A draft's local ref carries none, so the pane's own harness
  // store — the same scope the composer's selector writes — is the authority
  // there; reading only the ref left a draft's model store keyed by no harness.
  const harnessSelection = createMemo(() => {
    const ref = props.sessionRef?.()
    const fromRef = ref ? sessionHarness(ref) : undefined
    if (fromRef) return fromRef
    return harnessControllers.submit.harness(paneHarnessScope({
      directory: props.directory,
      sessionId: sessionId(),
      surfaceId: props.surfaceId?.(),
    }))
  })
  const harnessType = createMemo(() => {
    const selection = harnessSelection()
    return props.harnessType?.() ?? (selection ? harnessSelectionValue(selection) : undefined)
  })
  const refreshDirectory: Parameters<typeof DirectoryScope>[0]["refreshDirectory"] = (directory, harnessType, options) => {
    const current = connection()
    const workspace = current.workspaceId && current.kind !== "local"
      ? { workspaceId: current.workspaceId, kind: current.kind }
      : undefined
    if (!workspace) {
      return workspaceScopes?.refreshDirectory(directory, harnessType, options) ??
        directorySessionCacheActions.refresh({ directory, harnessType, ...options })
    }
    return workspaceScopes?.refreshDirectory(directory, harnessType, { ...options, workspace }) ??
      directorySessionCacheActions.refresh({ directory, harnessType, ...options, workspace })
  }
  // Resolve the workspace connection (id + kind) from the SINGLE authority seam.
  // Split panes for the same workspaceId acquire ONE shared connection inside
  // WorkspaceGate; local/no-backing panes resolve `local` and the gate is an
  // immediate no-op (loopback unchanged).
  // One retained pane owns one canonical connection identity. WorkspaceGate,
  // DirectoryScope and refresh callbacks all consume it; recomputing the
  // resolver independently at every getter read multiplied signed-workspace
  // and legacy-ref resolution during a focus change.
  const connection = createMemo(() =>
    sessionPaneWorkspaceConnection({
      directory: props.directory,
      sessionRef: props.sessionRef?.(),
      workspaceId: props.workspaceId?.(),
      projects: projects(),
    }))
  const workspaceKey = createMemo(() =>
    (connection().workspaceId ?? props.directory) || props.sessionRef?.()?.sessionId || "")
  const workspaceReady = createMemo(() => {
    const workspaceId = connection().workspaceId
    if (!workspaceId) return true
    return !!workspaceScopes?.scopeFor(workspaceKey())
  })

  const scopedContent = () => (
    <DirectoryScope
      directory={props.directory}
      sessionRef={props.sessionRef}
      harnessType={harnessType}
      harnessSelection={harnessSelection}
      workspaceId={() => connection().workspaceId}
      workspaceKind={() => connection().kind}
      active={props.active}
      sessionId={sessionId}
      surfaceId={props.surfaceId}
      workspaceReady={workspaceReady}
      refreshDirectory={refreshDirectory}
      onNavigateToSession={props.onNavigateToSession}
      onSessionHref={props.onSessionHref}
      onSyncSession={props.onSyncSession}
    >
      {props.children}
    </DirectoryScope>
  )

  return (
    <SessionParamsProvider
      sessionId={sessionId}
      directory={() => props.directory}
      paneId={() => props.paneId?.() ?? ""}
      surfaceId={props.surfaceId}
      leafId={props.leafId}
      active={props.active}
    >
      <PaneIdProvider paneId={props.paneId?.() ?? ""}>
       <GateSuppressedBySurface.Provider value={gateSuppressed}>
        {/* Key the gate by workspaceId so swapping the pane to a different
            workspace re-acquires a fresh connection; local panes (undefined
            id) key on the directory and the gate is an immediate no-op. */}
        <Show keyed when={workspaceKey()}>
          <Show
            when={!gateSuppressed()}
            fallback={
              // Panel boundary: never render the WorkspaceGate connecting/offline
              // surface here. The child region reads the shared authority and
              // decides whether to show loaded content or a mode-specific pending
              // overlay.
              scopedContent()
            }
          >
            <WorkspaceGate
              workspaceId={connection().workspaceId}
              kind={connection().kind}
              sessionId={sessionId()}
              directory={props.directory}
              serverUrl={globalSDK.url}
              request={platform.fetch ?? authFetch}
              relayRequest={platform.fetch ?? authFetch}
              connectingFallback={connection().kind === "user-hosted" ? undefined : props.connectionFallback}
            >
              {scopedContent()}
            </WorkspaceGate>
          </Show>
        </Show>
       </GateSuppressedBySurface.Provider>
      </PaneIdProvider>
    </SessionParamsProvider>
  )
}
