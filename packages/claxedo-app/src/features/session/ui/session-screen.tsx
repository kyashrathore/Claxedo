// Claxedo sessions can render inside independent Workbench panes, so this override uses pane-scoped params, cloud runtime gates, and the inline new-session composer.
import { onCleanup, onMount, Show, Match, Switch, Suspense, createMemo, createEffect, createComputed, createSignal, on, untrack } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLocal } from "@/features/session/providers/session-selection"
import { createStore } from "solid-js/store"
import { createAutoScroll } from "@opencode-ai/ui/hooks"
import { isWorkspaceReady, useClaxedoEventsOptional, useClaxedoState, useCommand, useConfigOptional, useGlobalSDK, useLayout, usePaneId, useSDK, useServer, useTerminal } from "@/features/session/app-ports"
import { addProjectAction } from "@/features/session/ui/components/session-add-project-action"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/platform/i18n/provider"
import { useLocation, useNavigate } from "@solidjs/router"
import { UserMessage, type SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { usePrompt } from "@/features/session/providers/prompt"
import { useComments } from "@/platform/comments/provider"
import { showToast } from "@opencode-ai/ui/toast"
import { NewSessionDesignView, SessionHeader, type NewSessionWorkspaceKind } from "@/features/session/ui/components"
import { createNewSessionWorkspaceState, type ProjectWorkspace } from "@/features/session/ui/components/session-new-workspace-options"
import { same } from "@/lib/same"
import { createSessionHistoryWindow, emptyUserMessages } from "@/features/session/ui/history-window"
import { createHistoryFill } from "@/features/session/ui/history-fill"
import { groupNavigateDirectory, groupNavigateUrlSync } from "@/features/session/ui/group-navigate-route"
import { setSessionHandoff, setTerminalHandoff } from "@/features/session/ui/prompt-preview-handoff"
import { terminalTabLabel } from "@/features/session/ui/terminal-label"
import { scheduleSessionCommandsAfterFirstPaint, useSessionCommands } from "@/features/session/ui/use-session-commands"
import { MessageTimeline, PromptInput, SessionComposerRegion } from "@/features/session/ui/session-screen-lazy"
import { createSessionComposerState } from "@/features/session/ui/composer/session-composer-state"
import { useSessionHashScroll } from "@/features/session/ui/use-session-hash-scroll"
import { useSessionParams } from "@/features/session/providers/session-params"
import { CloudStartupView, isForbiddenConnectionError, type CloudLog } from "@/features/session/ui/components/cloud-startup-view"
import { resolveSessionIdentity, resolveSignedSessionWorkspaceId, sessionSignedTransportAuthority, signedProjectWorkspaceId, signedRouteSessionWorkspaceId, type SessionIdentity } from "@/features/session/ui/session-identity"
import {
  shouldDispatchIdleAfterStaleBusyRefresh,
  shouldReconcileBusySessionToIdle,
  sessionFirstFoldReady,
  sessionMessagesReady,
  shouldRenderNewSessionComposer,
  resolveDraftWorkspaceKind,
  sessionSwitchResetPlan,
  sessionUserMessages,
  stableSessionInfo,
  stableSessionMessages,
  staleBusyReconciliationKey,
  timelineMountSessionKey,
  visibleSessionUserMessages,
} from "@/features/session/ui/view-state"
import { createSessionController } from "@/features/session/store/session-controller"
import { sameWorkspaceDirectory, signedWorkspaceFromProjects } from "@/platform/runtime/agent/signed-workspace"
import { getClaxedoServerUrl } from "@/platform/api/api"
import { principalHasSignedAccess, usePrincipal } from "@/platform/auth/identity-provider"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { placementFor } from "@/platform/runtime/placement"
import { parseShellRoute, sessionRoute, workspaceSessionRoute } from "@/platform/identity/route"
import { workspaceRouteId } from "@/platform/identity/workspace-route"
import { sessionViewKey, terminalScopeKey } from "@/platform/identity/session-view-key"
import { shellDataKeys } from "@/platform/sync/keys"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { retargetSessionRef } from "@/platform/identity/session-ref"
import { SessionConversationOwner } from "@/features/session/conversation/session-conversation-owner"
import { resumeSessionScroll } from "@/features/session/ui/session-message-scroll-position"
import { createActiveConversationSnapshot } from "@/features/session/conversation/conversation-registry"
import {
  scheduleDirectorySessionHydration, shouldScheduleDirectorySessionHydration,
  removeDirectorySession,
  updateDirectorySession,
  useDirectorySessionCacheActions,
} from "@/features/session/data/sync/directory-session-cache"
import { queryClient } from "@/platform/query/query-client"
import { mergeCanonicalSessionUpdate } from "@/features/session/data/sync/session-list-events"
import { dispatchSessionStatusEvent } from "@/features/session/store/session-status-dispatcher"
import { useSessionTitleProjection } from "@/features/session/providers/session-title-projection-provider"
import { createSessionComposerModes } from "@/features/session/ui/composer/session-composer-mode"
import { createNewSessionDeepLinkPromptSeed } from "@/features/session/ui/composer/deep-link-prompt"
import { assistantMessageIdForUserMessage, type ClaxedoSession } from "@/features/session/data/session-types"
import { usePromptHarnessControllersOptional } from "@/features/session/composer/ui/harness-controller"
import { emptyTitleEditorState, openTitleEditorPatch, resolveTitleSave } from "@/features/session/ui/session-title-editor"
import { nextSiblingAfterRemoval, sessionRemovalNavigation } from "@/features/session/ui/session-archive"
import { previewPromptText } from "@/features/session/ui/prompt-preview"
import { buildDiffKindTree } from "@/features/session/ui/diff-kind-tree"
import { computeScrollState, pickAnchorMessageId } from "@/features/session/ui/scroll-anchor"
import { createPromptDockResizeHandler } from "@/features/session/ui/resize-observer-scroll"
import { createSessionScreenKeydownHandler } from "@/features/session/ui/session-screen-keydown"
import { createSessionMessageActions } from "@/features/session/ui/session-message-actions"
import { createFirstTurnOnboarding, firstTurnHarnessRecovery } from "@/features/session/onboarding/first-turn-onboarding"
import { DeferredSessionSecondaryStatus } from "@/features/session/ui/components/session-secondary-status"
import { createActiveLocationSnapshot } from "@/features/session/ui/active-location-snapshot"
import { createActivePaneProjection } from "@/features/session/store/active-pane-projection"
import { createSessionScreenCacheProjection } from "@/features/session/ui/session-screen-cache-projection"
import { createParentSessionNavigation } from "@/features/session/ui/session-parent-navigation"
import { createNewSessionBranchSource } from "@/features/session/ui/components/session-new-branch-source"
import { useMarked } from "@opencode-ai/ui/context/marked"
import {
  firstFoldMarkdownBodies,
  firstFoldMarkdownPreloadIdentity,
  preloadSessionMarkdownBodies,
  sessionMarkdownTimelineGate,
} from "@/features/session/ui/content/session-markdown-preload"
export default function SessionPage() {
  const sessionParams = useSessionParams()
  const claxedoState = useClaxedoState()
  const paneId = usePaneId()
  const command = useCommand()
  const addProject = createMemo(() => addProjectAction(command))
  const layout = useLayout()
  const local = useLocal()
  const server = useServer()
  const terminal = useTerminal()
  const config = useConfigOptional()
  const dialog = useDialog()
  const language = useLanguage()
  const marked = useMarked()
  const navigate = useNavigate()
  const location = useLocation()
  const paneActive = () => sessionParams.active?.() ?? true
  const paneLocation = createActiveLocationSnapshot({
    active: paneActive,
    pathname: () => location.pathname,
    search: () => location.search,
    hash: () => location.hash,
  })
  const sdk = useSDK()
  const globalSDK = useGlobalSDK()
  const prompt = usePrompt()
  const sessionTitles = useSessionTitleProjection()
  const comments = useComments()
  const promptHarnessControllers = usePromptHarnessControllersOptional()
  const contentMetaSource = createMemo(() => {
    const surfaceId = sessionParams.surfaceId?.()
    if (!surfaceId) return
    return claxedoState.meta.get(surfaceId)
  })
  const activeContentMeta = createActivePaneProjection({ active: paneActive, read: contentMetaSource, initial: undefined as ReturnType<typeof contentMetaSource> })
  const activeSessionRef = () => activeContentMeta()?.content?.sessionRef
  const contentIntent = createMemo(() => activeContentMeta()?.content?.intent)
  const contentIntentDefaults = createMemo(() => contentIntent()?.defaults)
  // Inject default prompt text from pane intent (e.g. process-launched session pane)
  {
    let injected = false
    createEffect(
      on(
        () => [contentIntentDefaults()?.prompt, prompt.ready(), prompt.dirty()] as const,
        ([defaultPrompt, ready, dirty]) => {
          if (injected || !defaultPrompt || !ready || dirty) return
          injected = true
          const text = defaultPrompt
          prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
        },
      ),
    )
  }

  const sessionIdentity = createMemo<SessionIdentity>((prev) =>
    resolveSessionIdentity({
      previous: prev,
      pane: {
        id: sessionParams.sessionId(),
        directory: sessionParams.directory(),
        surfaceId: sessionParams.surfaceId?.(),
      },
    }),
  )
  const sessionID = createMemo(() => sessionIdentity().id)
  const routeDirectory = createMemo(() => sessionParams.directory())
  const terminalHandoffKey = createMemo(() => terminalScopeKey(routeDirectory()))
  const sessionTitleTarget = createMemo(() => {
    const sessionId = sessionID()
    if (!sessionId) return
    const route = parseShellRoute(paneLocation().pathname)
    const sessionRef = activeSessionRef()
    const central = sessionRef?.host === "central" || route.kind === "session"
    return {
      sessionId,
      ...(central ? {} : { directory: routeDirectory() }),
      ...(sessionRef ? { sessionRef } : {}),
    }
  })
  const sessionTitleSelection = createMemo(() => {
    const target = sessionTitleTarget()
    return target ? sessionTitles.select(target) : undefined
  })
  const inventorySession = createActivePaneProjection({ active: paneActive, read: () => sessionTitleSelection()?.inventory(), initial: undefined as ReturnType<NonNullable<ReturnType<typeof sessionTitleSelection>>["inventory"]> })
  // SessionPaneScope already resolved the pane's canonical runtime directory
  // and DirectoryScope exposes that same value as sdk.directory. Every query,
  // composer write, conversation registry and timeline read must share it.
  // Inventory still supplies workspace transport metadata below, but it must
  // never mint a second conversation scope inside an already-mounted pane.
  const dir = routeDirectory
  const cacheProjection = createSessionScreenCacheProjection({ active: paneActive, directory: dir })
  const projects = cacheProjection.projects
  const routeSessionWorkspaceId = createMemo(() => signedRouteSessionWorkspaceId(paneLocation().pathname, projects()))
  const directorySessions = cacheProjection.sessions
  const directorySession = (sessionID: string | undefined) =>
    sessionID ? directorySessions().find((session) => session.id === sessionID) : undefined
  const updateDirectorySessionCacheRow = (sessionID: string, update: (session: ClaxedoSession) => ClaxedoSession) => updateDirectorySession(dir(), sessionID, update)
  const directorySessionCacheActions = useDirectorySessionCacheActions()
  const principal = usePrincipal()
  const platform = usePlatform()
  const events = useClaxedoEventsOptional()
  const sameDirectory = (left?: string, right?: string) => sameWorkspaceDirectory(left, right)
  const activeProject = createMemo(() => {
    const cwd = dir()
    return projects().find((item) => {
      const workspaces = (item as typeof item & {
        workspaces?: Record<string, { directory?: string }>
      }).workspaces ?? {}
      return sameDirectory(item.worktree, cwd) ||
        item.sandboxes?.some((sandbox) => sameDirectory(sandbox, cwd)) ||
        Object.keys(workspaces).some((key) => sameDirectory(key, cwd)) ||
        Object.values(workspaces).some((workspace) => sameDirectory(workspace.directory, cwd))
    })
  })
  const ws = createMemo(
    () => {
      const cwd = dir()
      const project = activeProject()
      const workspaces = (project as typeof project & {
        workspaces?: Record<string, { id?: string; kind?: "local" | "cloud" | "user-hosted"; status?: string | null; directory?: string }>
      } | undefined)?.workspaces ?? {}
      const workspace =
        Object.entries(workspaces).find(([key]) => sameDirectory(key, cwd))?.[1] ??
        Object.values(workspaces).find((workspace) => sameDirectory(workspace.directory, cwd))
      return workspace
    },
  )
  const signedControlPlane = createMemo(() => {
    const workspaceId = routeSessionWorkspaceId()
    const workspace = sdk.workspace(dir()) ?? ws()
    const kind = workspace?.kind
    const cwd = dir()
    const placement = placementFor({
      // The typed ref can still be a provisional local ref while signed
      // inventory hydrates. The explicit `/w/:workspaceId` route is the
      // authority for this pane and must not be overridden by that stale ref.
      ref: workspaceId ? undefined : activeSessionRef(),
      hasSignedAccess: sessionSignedTransportAuthority({
        serverUrl: getClaxedoServerUrl(),
        principalHasSignedAccess: principalHasSignedAccess(principal()),
        routeWorkspaceAuthorityId: workspaceId,
        workspaceKind: kind,
        sessionRef: activeSessionRef(),
      }),
      serverUrl: getClaxedoServerUrl(),
      legacy: {
        directory: cwd,
        workspaceId,
        workspaceKind: kind,
      },
    })
    return !!placement && placement.transport !== "loopback"
  })
  const signedDirectoryWorkspace = createMemo(() => signedWorkspaceFromProjects(projects(), dir()))
  const directoryWorkspaceRuntime = createMemo(() => sessionWorkspaceRuntimeRef({ directory: dir() }))
  const inventoryAwareWorkspaceRuntime = createMemo(() =>
    sessionWorkspaceRuntimeRef({ directory: dir(), projects: projects() }))
  const signedRuntimeWorkspace = createMemo(() => {
    const workspaceId = directoryWorkspaceRuntime()?.workspaceId
    return workspaceId ? signedWorkspaceFromProjects(projects(), workspaceId) : undefined
  })
  const signedWorkspaceId = createMemo(() =>
    resolveSignedSessionWorkspaceId({
      signedControlPlane: signedControlPlane(),
      routeDirectory: routeSessionWorkspaceId(),
      inventoryWorkspaceId: inventorySession()?.workspaceId,
      projectWorkspaceId: signedProjectWorkspaceId({
        signedWorkspace: signedDirectoryWorkspace(),
        workspace: ws() as { id?: string; workspaceId?: string; kind?: string } | undefined,
      }),
      workspaceId: directoryWorkspaceRuntime()?.workspaceId,
    }),
  )
  const replayWorkspaceId = createMemo(() => inventorySession()?.workspaceId ?? signedWorkspaceId() ?? ((sdk.workspace(dir()) ?? ws()) as { id?: string; workspaceId?: string } | undefined)?.workspaceId ?? ((sdk.workspace(dir()) ?? ws()) as { id?: string; workspaceId?: string } | undefined)?.id)
  const routeIdForDirectory = (value: string) => (sameDirectory(value, dir()) ? routeSessionWorkspaceId() : undefined) ?? workspaceRouteId(projects(), value)
  // Resolve split-draft transport kind from full inventory so every pane agrees.
  const resolvedWorkspaceKind = createMemo<"cloud" | "user-hosted" | undefined>(() => {
    const inventoryKind = inventorySession()?.environment?.kind
    if (inventoryKind === "cloud" || inventoryKind === "user-hosted") return inventoryKind
    const kind = ws()?.kind
    if (kind === "cloud" || kind === "user-hosted") return kind
    // Match the inventory by directory first, then by the workspace id encoded
    // in a `workspace:<id>` ref — the split pane's `dir()` is often the id-ref
    // form, which `signedWorkspaceFromProjects` won't match as a directory.
    const fromDirectory = signedDirectoryWorkspace()?.kind
    if (fromDirectory) return fromDirectory
    return signedRuntimeWorkspace()?.kind
  })
  const routeWorkspaceKind = createMemo<NewSessionWorkspaceKind>(() => {
    // On a fresh DRAFT nav the inventory hasn't resolved yet and the only signal
    // is the directory-ref fallback — resolveDraftWorkspaceKind carries the ref's
    // OWN kind through instead of collapsing every ref to "cloud" (the collapse
    // mis-routed ws_-shaped user-hosted draft navs into the Local/Cloud picker).
    return resolveDraftWorkspaceKind({
      resolvedKind: resolvedWorkspaceKind(),
      fallbackRefKind: inventoryAwareWorkspaceRuntime()?.kind,
      // The hosted web build has no local machine behind it, so a draft that
      // resolves nothing must still default to cloud rather than to an
      // environment it can never run in.
      webOnlyCloud: platform.platform === "web" && signedControlPlane(),
    })
  })
  // BUG-2: the new-session composer (NewSessionDesignView below) must NOT render
  // alongside the WorkspaceGate's offline/connecting panel for a relay-backed
  // workspace — that produced the documented two-contradicting-states bug (the
  // composer looked fine while the gate said "Workspace failed to start"). For a
  // relay-backed scope it renders only when the single WorkspaceConnection
  // authority reports `ready`. The LOCAL/central case (no relay workspaceId)
  // keeps showing the composer normally — `isWorkspaceReady` is gated only when a
  // workspaceId exists, so loopback is unchanged.
  const newSessionComposerReady = createMemo(() => {
    const workspaceId = signedWorkspaceId()
    return shouldRenderNewSessionComposer({ workspaceId, workspaceReady: workspaceId ? isWorkspaceReady(workspaceId) : false })
  })
  // Workspace cloud-vs-user-hosted resolution + the per-pane connecting gate
  // (`needsCloudSandbox` / `userHostedWorkspaceId` + the pre-connect effects)
  // moved to the WorkspaceConnection authority (WorkspaceGate in
  // SessionPaneScope). The shared authority makes split panes agree on kind by
  // construction, retiring the per-pane re-derivation that used to misroute a
  // user-hosted workspace into the cloud sandbox flow in the second pane.
  // The "is this workspace connected?" concern is now owned by the single
  // WorkspaceConnection authority (WorkspaceGate, mounted in SessionPaneScope
  // OUTSIDE this component). This Session only mounts inside the gate's `ready`
  // branch, so it no longer reconstructs a pre-connect gate or runs its own
  // mint/health/provision pre-connect effects — those duplicated the authority
  // and caused the BUG-1 blank + double-connecting screens in split panes.
  //
  // The `gate` store survives ONLY for the new-session SUBMIT flow: when the
  // composer provisions a brand-new cloud sandbox at submit time it reports
  // progress through `onCloudStartup` (see the composer render below). That is a
  // distinct, transient submit-time concern, not the workspace-connection gate.
  const [gate, setGate] = createStore({
    open: false,
    sync: false,
    id: undefined as string | undefined,
    status: undefined as string | undefined,
    err: undefined as string | undefined,
    logs: [] as CloudLog[],
    variant: "cloud" as "cloud" | "user-hosted",
  })
  // BUG-9: A 403 from the connection mint means "you don't have access to this
  // workspace" — a terminal state, not a transient connecting one. The gate's
  // error path (user-hosted health probe / cloud resolve) carries the 403 in its
  // message. When that is detected, render the access-denied gate variant instead
  // of the "waiting for host" pipeline, and stop treating the gate as a retryable
  // connecting state.
  const gateForbidden = createMemo(() => gate.open && isForbiddenConnectionError(gate.err))
  const resetGate = () => {
    setGate({
      open: false,
      sync: false,
      id: undefined,
      status: undefined,
      err: undefined,
      logs: [],
      variant: "cloud",
    })
  }
  // The new-session SUBMIT flow (composer `onCloudStartup`) sets `gate.sync`
  // when a freshly-provisioned cloud runtime is ready and we are waiting for the
  // session-cache to land before swapping to the conversation. Close the gate
  // once that data arrives. (Workspace-CONNECTION gating moved to WorkspaceGate;
  // this effect only services the submit-time provisioning handoff.)
  createEffect(() => {
    if (!gate.sync) return
    if (!cacheProjection.directoryReady()) return
    setGate("open", false)
    setGate("sync", false)
    setGate("err", undefined)
  })

  // Sync cross-workspace URLs; route-intent resolves them onto the existing pane.
  const syncGroupNavigateUrl = (path: string) => {
    if (window.__NOSYNC__) return
    const sync = groupNavigateUrlSync({ targetPath: path, currentPathname: paneLocation().pathname })
    if (sync) navigate(sync, { replace: true })
  }
  const groupNavigate = (path: string, targetDirectory?: string) => {
    const gid = sessionParams.paneId() ?? paneId
    const current = sessionParams.directory()
    if (gid && current && claxedoState) {
      const route = parseShellRoute(path)
      const dir = groupNavigateDirectory({ targetPath: path, currentDirectory: current, targetDirectory })
      const sid = route.kind === "legacy-directory" ? route.sessionId : undefined
      const target = claxedoState.wb.state.panes.some((pane) => pane.id === gid)
        ? gid
        : (claxedoState.wb.state.focusedPaneId ?? gid)
      claxedoState.workspace.setPaneWorktreeDefault(target, dir)
      claxedoState.wb.split.focus(target)

      if (sid) {
        claxedoState.layout.openSession(dir, sid, "Session", {
          sessionRef: retargetSessionRef({
            sessionId: sid,
            source: activeSessionRef(),
          }),
        })
        syncGroupNavigateUrl(path)
      } else if (route.kind === "legacy-directory" || route.kind === "workspace-session") {
        claxedoState.layout.openSession(dir, "new", "New Session")
        syncGroupNavigateUrl(path)
      } else {
        navigate(path)
      }
    } else {
      navigate(path)
    }
  }

  const composerState = createSessionComposerState()

  const navigateSession = (id?: string) => {
    const directory = dir()
    if (!directory) return
    if (id) {
      groupNavigate(sessionRoute(id))
      return
    }
    const workspaceId = routeIdForDirectory(directory)
    if (workspaceId) groupNavigate(workspaceSessionRoute(workspaceId), directory)
  }

  const sessionController = createSessionController({
    directory: dir,
    sessionID: () => sessionID(),
    serverHealthy: () => server.healthy(),
    active: paneActive,
    signedControlPlane,
    workspaceId: replayWorkspaceId,
    workspaceKind: resolvedWorkspaceKind,
    sessionRef: activeSessionRef,
  })
  const [ui, setUi] = createStore({
    pendingMessage: undefined as string | undefined,
    restoring: undefined as string | undefined,
    scrollGesture: 0,
    scroll: {
      overflow: false,
      bottom: true,
      jump: false,
    },
  })
  const sessionKey = createMemo(() =>
    sessionViewKey({
      directory: dir(),
      sessionId: sessionID(),
      draftId: sessionParams.surfaceId?.(),
    })
  )
  const infoState = createMemo((prev: ReturnType<typeof stableSessionInfo>) =>
    stableSessionInfo(prev, sessionKey(), sessionController.info()),
  )
  const info = createMemo(() => infoState()?.value)
  const navigateParent = createParentSessionNavigation(info, sessionID, claxedoState, navigate)
  createEffect(() => {
    if (!paneActive()) return
    const sessionIDValue = sessionID()
    const directory = dir()
    if (!sessionIDValue || !shouldScheduleDirectorySessionHydration({ directory, sessionID: sessionIDValue, hasSessionInfo: !!info(), sessionRef: activeSessionRef() })) return
    const cancel = scheduleDirectorySessionHydration({
      directory, sessionID: sessionIDValue,
      getSession: (parameters) => sdk.client.session.get(parameters).then((result) => result.data),
    })
    onCleanup(cancel)
  })
  createEffect(() => {
    if (!paneActive()) return
    const target = sessionTitleTarget()
    const value = info()
    if (!target || !value?.title) return
    sessionTitles.publishCanonical({
      ...target,
      directory: dir(),
      title: value.title,
      updatedAt: value.time.updated,
    })
  })
  const resolvedTitle = createActivePaneProjection<string | undefined>({
    active: paneActive,
    read: () => sessionTitleSelection()?.title() ?? activeContentMeta()?.content?.title ?? info()?.title,
    initial: undefined,
  })
  const diffs = sessionController.diffs
  const todos = sessionController.todos
  const reviewCount = createMemo(() => Math.max(info()?.summary?.files ?? 0, diffs().length))
  const hasReview = createMemo(() => reviewCount() > 0)

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const centered = createMemo(() => isDesktop())

  const revertMessageID = createMemo(() => info()?.revert?.messageID)
  const messageState = createMemo((prev: ReturnType<typeof stableSessionMessages> | undefined) =>
    stableSessionMessages(prev as Parameters<typeof stableSessionMessages>[0], sessionKey(), sessionController.messages()),
  )
  const messages = createMemo(() => messageState()?.value ?? [])
  const conversation = createActiveConversationSnapshot({ directory: dir, sessionID, active: paneActive })
  const sessionMissing = createMemo(() => sessionController.missing())
  const messagesReady = createMemo(() =>
    sessionMessagesReady({
      sessionId: sessionID(),
      sessionMissing: sessionMissing(),
      messagesLoaded: messageState()?.value !== undefined,
    }),
  )
  // Warm historical switches: mount the timeline as soon as messages are ready.
  // Sync rich first paint (markdown.tsx) prevents plain→rich flash. Idle preload
  // warms the cache off the critical path so marked.parse cannot delay timeline
  // rows or starve workspace-panel Files readiness (waitForOpenFiles).
  const firstFoldIdentity = createMemo(() =>
    firstFoldMarkdownPreloadIdentity(conversation()?.messages ?? []),
  )
  createEffect(() => {
    const ready = messagesReady()
    const key = sessionKey()
    const gate = sessionMarkdownTimelineGate({
      messagesReady: ready,
      sessionKey: key,
      firstFoldIdentity: firstFoldIdentity(),
    })
    if (gate !== "preload") return
    const snapshot = untrack(() => conversation())
    const bodies = firstFoldMarkdownBodies({
      messages: snapshot?.messages ?? [],
      parts: snapshot?.parts ?? {},
    })
    if (bodies.length === 0) return
    let cancelled = false
    const schedule =
      typeof globalThis.requestIdleCallback === "function"
        ? (cb: () => void) => {
            const id = globalThis.requestIdleCallback(() => cb(), { timeout: 2_000 })
            return () => globalThis.cancelIdleCallback?.(id)
          }
        : (cb: () => void) => {
            const id = setTimeout(cb, 0)
            return () => clearTimeout(id)
          }
    const cancelSchedule = schedule(() => {
      if (cancelled) return
      void preloadSessionMarkdownBodies(bodies, marked)
    })
    onCleanup(() => {
      cancelled = true
      cancelSchedule()
    })
  })
  const firstFoldReady = createMemo(() =>
    sessionFirstFoldReady({
      sessionId: sessionID(),
      sessionMissing: sessionMissing(),
      hasSessionInfo: !!info(),
      hasInventorySession: !!inventorySession(),
      messagesReady: messagesReady(),
    }),
  )
  const historyMore = createMemo(() => {
    const id = sessionID()
    if (!id) return false
    return sessionController.historyMore()
  })
  const historyLoading = createMemo(() => {
    const id = sessionID()
    if (!id) return false
    return sessionController.historyLoading()
  })
  const [title, setTitle] = createStore({
    draft: "",
    editing: false,
    saving: false,
    menuOpen: false,
    pendingRename: false,
  })
  let titleRef: HTMLInputElement | undefined

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  createEffect(
    on(
      sessionKey,
      () => setTitle(emptyTitleEditorState()),
      { defer: true },
    ),
  )

  const openTitleEditor = () => {
    const patch = openTitleEditorPatch({ hasSession: !!sessionID(), currentTitle: info()?.title })
    if (!patch) return
    setTitle(patch)
    requestAnimationFrame(() => {
      titleRef?.focus()
      titleRef?.select()
    })
  }

  const closeTitleEditor = () => {
    if (title.saving) return
    setTitle({ editing: false, saving: false })
  }

  const saveTitleEditor = async () => {
    const currentSessionID = sessionID()
    if (!currentSessionID) return
    if (title.saving) return

    const decision = resolveTitleSave({ draft: title.draft, currentTitle: info()?.title })
    if (!decision.commit) {
      setTitle({ editing: false, saving: false })
      return
    }
    const next = decision.title
    const baseline = directorySession(currentSessionID)

    setTitle("saving", true)
    await sdk.client.session
      .update({ sessionID: currentSessionID, title: next })
      .then((result) => {
        if (result.data) {
          updateDirectorySessionCacheRow(currentSessionID, (session) => mergeCanonicalSessionUpdate(session, result.data, baseline))
          sessionTitles.publishCanonical({
            sessionId: currentSessionID,
            directory: dir(),
            ...(activeSessionRef() ? { sessionRef: activeSessionRef() } : {}),
            title: result.data.title,
            updatedAt: result.data.time.updated,
          })
        }
        setTitle({ editing: false, saving: false })
      })
      .catch((err) => {
        setTitle("saving", false)
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        })
      })
  }

  async function archiveSession(targetSessionID: string) {
    const session = directorySession(targetSessionID)
    if (!session) return

    const nextSession = nextSiblingAfterRemoval(directorySessions(), targetSessionID)

    await sdk.client.session
      .update({ sessionID: targetSessionID, time: { archived: Date.now() } })
      .then(() => {
        removeDirectorySession(dir(), targetSessionID)

        const nav = sessionRemovalNavigation({
          currentSessionID: sessionID(),
          targetSessionID,
          parentID: session.parentID,
          nextSessionID: nextSession?.id,
        })
        if (nav.kind === "parent" || nav.kind === "next") {
          groupNavigate(sessionRoute(nav.sessionID))
          return
        }
        if (nav.kind === "root") {
          const workspaceId = routeIdForDirectory(dir())
          if (workspaceId) groupNavigate(workspaceSessionRoute(workspaceId), dir())
        }
      })
      .catch((err) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        })
      })
  }

  const userMessages = createMemo(
    () => sessionUserMessages(messages()),
    emptyUserMessages,
    { equals: same },
  )
  const firstTurnOnboarding = createFirstTurnOnboarding({
    directory: dir,
    messages,
    cloud: () => resolvedWorkspaceKind() === "cloud",
    onStartNewSession: () => navigateSession(),
    harnessRecovery: () => firstTurnHarnessRecovery(promptHarnessControllers.selection, dir(), sessionID(), sessionParams.surfaceId?.(), activeSessionRef()),
  })
  const visibleUserMessages = createMemo(
    () => {
      const revert = revertMessageID()
      return visibleSessionUserMessages({
        userMessages: userMessages(),
        revertMessageId: revert,
      })
    },
    emptyUserMessages,
    {
      equals: same,
    },
  )
  const lastUserMessage = createMemo(() => visibleUserMessages().at(-1))
  const sessionLastTurn = createMemo(() => info()?.lastTurn)
  const activeAssistantMessageId = createMemo(() => assistantMessageIdForUserMessage(lastUserMessage()?.id))
  const busyStatusIsStale = createMemo(() =>
    shouldReconcileBusySessionToIdle({
      lastTurn: sessionLastTurn(),
      assistantMessageId: activeAssistantMessageId(),
    }),
  )

  createEffect(() => {
    if (!paneActive()) return
    const msg = lastUserMessage()
    if (!msg) return
    local.session.restore(msg)
  })

  const [store, setStore] = createStore({
    expanded: {} as Record<string, boolean>,
    messageId: undefined as string | undefined,
    newSessionWorktree: "main",
    newSessionWorkspaceKind: routeWorkspaceKind(),
    newSessionControlsTouched: false,
    deferRender: false,
  })

  createComputed((prev) => {
    const key = sessionKey()
    if (key !== prev) {
      setStore("deferRender", true)
      requestAnimationFrame(() => {
        setTimeout(() => setStore("deferRender", false), 0)
      })
    }
    return key
  }, sessionKey())

  const newSessionWorktree = createMemo(() => {
    if (store.newSessionWorktree === "create") return "create"
    if (store.newSessionWorktree !== "main") return store.newSessionWorktree
    const project = activeProject()
    if (project && dir() !== project.worktree) return dir()
    return "main"
  })
  const composerModes = createSessionComposerModes({
    directory: dir, draftId: () => sessionParams.surfaceId?.(), sessionId: sessionID, sessionRef: activeSessionRef,
    signedControlPlane, workspaceId: signedWorkspaceId, workspaceKind: () => store.newSessionWorkspaceKind, worktree: newSessionWorktree,
  })
  const newSession = createMemo(() => !sessionID() || sessionID() === "new")
  const newSessionBranchSource = createNewSessionBranchSource({ enabled: newSession, directory: () => activeProject()?.worktree ?? dir(), worktree: newSessionWorktree,
    touch: () => setStore("newSessionControlsTouched", true), setWorktree: (value) => setStore("newSessionWorktree", value) })
  const newSessionBranch = newSessionBranchSource.selected, newSessionBaseRef = () => newSessionBranch()?.gitRef,
    newSessionSourceBranch = () => newSessionBranch()?.sourceBranch
  createEffect(
    on(sessionKey, () => {
      if (!newSession()) return
      setStore("newSessionControlsTouched", false)
    }),
  )
  createEffect(() => {
    if (!newSession()) return
    if (store.newSessionControlsTouched) return
    setStore("newSessionWorkspaceKind", routeWorkspaceKind())
    if (store.newSessionWorktree !== "main") setStore("newSessionWorktree", "main")
  })
  createNewSessionDeepLinkPromptSeed({
    newSession,
    search: () => paneLocation().search,
    prompt,
    replaceSearch: (search) => {
      const current = paneLocation()
      navigate(`${current.pathname}${search}${current.hash}`, { replace: true })
    },
  })
  const newSessionWorkspaceState = (kind: NewSessionWorkspaceKind) => {
    const project = activeProject()
    return createNewSessionWorkspaceState({
      projectRoot: project?.worktree ?? sdk.directory,
      selectedWorktree: newSessionWorktree(),
      workspaceKind: kind,
      sandboxes: project?.sandboxes ?? [],
      workspaces: ((project as (typeof project & { workspaces?: Record<string, ProjectWorkspace> }) | undefined)?.workspaces ?? {}),
    })
  }
  const newSessionWorkspaceOptions = (kind: NewSessionWorkspaceKind) => {
    return newSessionWorkspaceState(kind).options
  }
  const setNewSessionWorkspaceKind = (value: NewSessionWorkspaceKind) => {
    // The web composer never offers "local" (no local machine behind the
    // renderer). Guard here too so a stale/deep-linked selection cannot route a
    // hosted web draft into an environment it can never run in.
    if (value === "local" && platform.platform === "web" && signedControlPlane()) return
    setStore("newSessionControlsTouched", true)
    setStore("newSessionWorkspaceKind", value)
    if (newSessionWorktree() === "create") return
    if (newSessionWorkspaceOptions(value).includes(newSessionWorktree())) return
    const next = newSessionWorkspaceOptions(value)[0] ?? (value === "cloud" ? "create" : "main")
    newSessionBranchSource.syncWorktree(next)
    setStore("newSessionWorktree", next)
  }
  const changeNewSessionWorktree = (value: string) => {
    setStore("newSessionControlsTouched", true)
    newSessionBranchSource.syncWorktree(value)
    if (value === "create") {
      setStore("newSessionWorktree", value)
      return
    }
    setStore("newSessionWorktree", "main")
    const target = value === "main" ? activeProject()?.worktree : value
    if (!target) return
    if (target === dir()) return
    const workspaceId = routeIdForDirectory(target)
    if (!workspaceId) return
    layout.projects.open(target)
    groupNavigate(workspaceSessionRoute(workspaceId), target)
  }
  let inputRef!: HTMLDivElement
  let promptDock: HTMLDivElement | undefined
  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let scrollMark = 0
  let messageMark = 0

  const activeMessage = createMemo(() => {
    const id = store.messageId && messageMark === scrollMark ? store.messageId : cursor()
    if (!id) return lastUserMessage()
    const found = visibleUserMessages()?.find((m) => m.id === id)
    return found ?? lastUserMessage()
  })
  const setActiveMessage = (message: UserMessage | undefined) => {
    messageMark = scrollMark
    setStore("messageId", message?.id)
  }

  function navigateMessageByOffset(offset: number) {
    const msgs = visibleUserMessages()
    if (msgs.length === 0) return

    const current = store.messageId && messageMark === scrollMark ? store.messageId : cursor()
    const base = current ? msgs.findIndex((m) => m.id === current) : msgs.length
    const currentIndex = base === -1 ? msgs.length : base
    const targetIndex = currentIndex + offset
    if (targetIndex < 0 || targetIndex > msgs.length) return

    if (targetIndex === msgs.length) {
      resumeScroll()
      return
    }

    autoScroll.pause()
    scrollToMessage(msgs[targetIndex], "auto")
  }

  const kinds = createMemo(() => buildDiffKindTree(diffs()))
  const emptyDiffFiles: string[] = []
  const diffFiles = createMemo(
    () => diffs().map((d: SnapshotFileDiff) => d.file).filter((file): file is string => !!file),
    emptyDiffFiles,
    { equals: same },
  )
  const diffsReady = createMemo(() => {
    if (!hasReview()) return true
    return sessionController.diffsReady()
  })

  const scrollGestureWindowMs = 250

  const markScrollGesture = (target?: EventTarget | null) => {
    const root = scroller
    if (!root) return

    const el = target instanceof Element ? target : undefined
    const nested = el?.closest("[data-scrollable]")
    if (nested && nested !== root) return

    setUi("scrollGesture", Date.now())
  }

  const hasScrollGesture = () => Date.now() - ui.scrollGesture < scrollGestureWindowMs

  createEffect(
    on(
      () => visibleUserMessages().at(-1)?.id,
      (lastId, prevLastId) => {
        if (lastId && prevLastId && lastId > prevLastId) {
          setStore("messageId", undefined)
        }
      },
      { defer: true },
    ),
  )

  const status = sessionController.status

  createEffect(
    on(
      sessionKey,
      () => {
        setStore("messageId", undefined)
        setStore("expanded", {})
        setUi("pendingMessage", undefined)
        setUi("restoring", undefined)
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      dir,
      (directory) => {
        if (!directory) return
        setStore("newSessionWorktree", "main")
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [lastUserMessage()?.id, status().type] as const,
      ([id, statusType]) => {
        if (!id) return
        setStore("expanded", id, statusType === "busy" || statusType === "retry")
      },
    ),
  )

  let lastStaleBusyReconciliation: string | undefined
  createEffect(
    on(
      () => [
        staleBusyReconciliationKey({
          sessionId: sessionID(),
          statusType: status().type,
          stale: busyStatusIsStale(),
          blocked: sessionController.blocked(),
          assistantMessageId: activeAssistantMessageId(),
          lastTurn: sessionLastTurn(),
        }),
        sessionID(),
      ] as const,
      ([key, id]) => {
        if (!key) {
          lastStaleBusyReconciliation = undefined
          return
        }
        if (!id || lastStaleBusyReconciliation === key) return
        lastStaleBusyReconciliation = key
        void sessionController.refreshMeta(id, { force: true, includeRequests: false, instrumentPoll: true }).then(() => {
          if (sessionID() !== id) return
          const refreshedStatus = queryClient.getQueryData<SessionStatus>(shellDataKeys.sessionId(id, "status"))
          if (!shouldDispatchIdleAfterStaleBusyRefresh({ statusType: refreshedStatus?.type ?? status().type })) return
          dispatchSessionStatusEvent({
            event: { type: "session.idle", source: "server", sessionID: id },
          })
        })
      },
    ),
  )

  const handleKeyDown = createSessionScreenKeydownHandler({
    active: paneActive,
    dialogActive: () => dialog.active,
    inputEl: () => inputRef,
    composerBlocked: () => composerState.blocked(),
    prompt,
    markScrollGesture: () => markScrollGesture(),
  })

  const fileTreeTab = () => layout.fileTree.tab()
  const setFileTreeTab = (value: "changes" | "all") => layout.fileTree.setTab(value)

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    setFileTreeTab("all")
  }

  const focusInput = () => inputRef?.focus()

  useSessionCommands({
    active: paneActive,
    scheduleInitialCommands: scheduleSessionCommandsAfterFirstPaint,
    sessionId: sessionID,
    directory: dir,
    workspaceRouteId: routeIdForDirectory,
    activeMessage,
    showAllFiles,
    navigateMessageByOffset,
    setExpanded: (id, fn) => setStore("expanded", id, fn),
    setActiveMessage,
    focusInput,
    status: sessionController.status,
    capabilities: sessionController.capabilities,
  })

  const autoScroll = createAutoScroll({
    working: () => true,
    overflowAnchor: "none",
  })
  createEffect(
    on(
      sessionID,
      (id, previous) => {
        if (!id || !previous || id === previous) return
        if (paneLocation().hash || store.messageId || ui.pendingMessage) return
        autoScroll.resume()
      },
    ),
  )

  let scrollStateFrame: number | undefined
  let scrollStateTarget: HTMLDivElement | undefined
  let scrollToEnd = () => {}
  let scrollToTimelineMessage = (_id: string, _behavior: ScrollBehavior) => false

  const updateScrollState = (el: HTMLDivElement) => {
    const { overflow, bottom, jump } = computeScrollState({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTop: el.scrollTop,
    })

    if (ui.scroll.overflow === overflow && ui.scroll.bottom === bottom && ui.scroll.jump === jump) return
    setUi("scroll", { overflow, bottom, jump })
  }

  const scheduleScrollState = (el: HTMLDivElement) => {
    scrollStateTarget = el
    if (scrollStateFrame !== undefined) return

    scrollStateFrame = requestAnimationFrame(() => {
      scrollStateFrame = undefined

      const target = scrollStateTarget
      scrollStateTarget = undefined
      if (!target) return

      updateScrollState(target)
    })
  }

  const resumeScroll = () => {
    const el = scroller
    resumeSessionScroll({
      clearMessageSelection: () => setStore("messageId", undefined),
      clearMessageHash, resumeAutoScroll: autoScroll.resume,
      scrollToEnd, scheduleScrollState: () => { if (el) scheduleScrollState(el) },
    })
  }

  // When the user returns to the bottom, treat the active message as "latest".
  createEffect(
    on(
      autoScroll.userScrolled,
      (scrolled) => {
        if (scrolled) return
        // A converging programmatic jump transiently reads as "at bottom";
        // clearing here would cancel it mid-flight and strand the scroll.
        if (seeking()) return
        setStore("messageId", undefined)
        clearMessageHash()
      },
      { defer: true },
    ),
  )

  const anchor = (id: string) => `message-${id}`
  function cursor() {
    const root = scroller
    if (!root) return store.messageId

    const box = root.getBoundingClientRect()
    const line = box.top + 100
    const list = [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
      .map((el) => {
        const id = el.dataset.messageId
        if (!id) return

        const rect = el.getBoundingClientRect()
        return { id, top: rect.top, bottom: rect.bottom }
      })
      .filter((item): item is { id: string; top: number; bottom: number } => !!item)

    return pickAnchorMessageId({ items: list, box, line, fallback: store.messageId })
  }

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
    if (!el) return
    scheduleScrollState(el)
    scheduleHistoryFill()
  }

  const markUserScroll = () => {
    scrollMark += 1
  }

  createResizeObserver(
    () => content,
    () => {
      const el = scroller
      if (el) scheduleScrollState(el)
      scheduleHistoryFill()
    },
  )

  let captureHistoryAnchor = () => {}
  let restoreHistoryAnchor = () => {}
  const historyWindow = createSessionHistoryWindow({
    sessionID: () => sessionID(),
    messagesReady,
    visibleUserMessages,
    historyMore,
    historyLoading,
    loadMore: (sessionID) => sessionController.loadMore(sessionID),
    userScrolled: autoScroll.userScrolled,
    scroller: () => scroller,
    onBeforeLoad: () => captureHistoryAnchor(),
    onAfterLoad: () => restoreHistoryAnchor(),
    onBeforeReveal: () => captureHistoryAnchor(),
    onAfterReveal: () => restoreHistoryAnchor(),
  })

  // See `createHistoryFill` for why the decision is confirmed across two frames.
  const historyFill = createHistoryFill({
    eligible: () => {
      if (!sessionID() || !messagesReady()) return false
      if (autoScroll.userScrolled() || historyLoading()) return false

      const el = scroller
      if (!el) return false
      if (el.scrollHeight > el.clientHeight + 1) return false
      if (historyWindow.turnStart() <= 0 && !historyMore()) return false

      return true
    },
    reveal: () => void historyWindow.loadAndReveal(),
  })

  const scheduleHistoryFill = () => historyFill.schedule()

  createEffect(
    on(
      () => [sessionKey(), paneActive()] as const,
      ([key, active]) => {
        historyFill.activate(active ? key : undefined)
        if (active) scheduleHistoryFill()
      },
    ),
  )

  createEffect(
    on(
      sessionKey,
      () => {
        const plan = sessionSwitchResetPlan({
          locationHash: paneLocation().hash,
          pendingMessage: ui.pendingMessage,
        })
        if (plan.clearMessageId) setStore("messageId", undefined)
        if (!plan.restoreScroll) return
        autoScroll.resume()
        scrollToEnd()
        const el = scroller
        if (el) scheduleScrollState(el)
        scheduleHistoryFill()
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () =>
        [
          sessionID(),
          messagesReady(),
          historyWindow.turnStart(),
          historyMore(),
          historyLoading(),
          autoScroll.userScrolled(),
          visibleUserMessages().length,
        ] as const,
      ([id, ready, start, more, loading, scrolled]) => {
        if (!id || !ready || loading || scrolled) return
        if (start <= 0 && !more) return
        scheduleHistoryFill()
      },
      { defer: true },
    ),
  )

  const promptDockResize = createPromptDockResizeHandler({
    scroller: () => scroller,
    userScrolled: autoScroll.userScrolled,
    scrollToEnd: () => scrollToEnd(),
    scheduleScrollState,
    scheduleHistoryFill,
  })
  createResizeObserver(() => promptDock, ({ height }) => promptDockResize.resize(height))

  const { draft, supports, restore, rolled, actions } = createSessionMessageActions({
    sessionID: () => sessionID(),
    directory: dir,
    sdk,
    language,
    prompt,
    sessionController,
    conversation,
    userMessages,
    revertMessageID,
    restoring: () => ui.restoring,
    setRestoring: (id) => setUi("restoring", id),
    clearRestoring: (id) => setUi("restoring", (value) => (value === id ? undefined : value)),
    navigateSession,
    errorMessage,
  })

  const { clearMessageHash, scrollToMessage, seeking } = useSessionHashScroll({
    sessionKey,
    sessionID: () => sessionID(),
    messagesReady,
    visibleUserMessages,
    historyMore,
    historyLoading,
    loadMore: (sessionID) => sessionController.loadMore(sessionID),
    currentMessageId: () => store.messageId,
    pendingMessage: () => ui.pendingMessage,
    setPendingMessage: (value) => setUi("pendingMessage", value),
    setActiveMessage,
    autoScroll: {
      pause: autoScroll.pause,
      forceScrollToBottom: () => {
        autoScroll.resume()
        scrollToEnd()
      },
    },
    scroller: () => scroller,
    scrollToMessageOffset: (id, behavior) => scrollToTimelineMessage(id, behavior),
    anchor,
    revealMessage: historyWindow.revealTurn,
    scheduleScrollState,
    consumePendingMessage: layout.pendingMessage.consume,
  })

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown)
  })

  createEffect(() => {
    if (!paneActive()) return
    if (!prompt.ready()) return
    setSessionHandoff(sessionKey(), { prompt: previewPromptText(prompt.current()) })
  })

  createEffect(() => {
    if (!paneActive()) return
    if (!terminal.ready()) return
    language.locale()

    setTerminalHandoff(
      terminalHandoffKey(),
      terminal.all().map((pty) =>
        terminalTabLabel({
          title: pty.title,
          titleNumber: pty.titleNumber,
          t: language.t as (key: string, vars?: Record<string, string | number | boolean>) => string,
        }),
      ),
    )
  })

  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown)
    if (scrollStateFrame !== undefined) cancelAnimationFrame(scrollStateFrame)
    historyFill.cancel()
    promptDockResize.dispose()
  })

  return (
    <div
      class="relative bg-background-base size-full overflow-hidden flex flex-col"
      data-testid="session-page-root"
      data-session-id={sessionID() ?? ""}
      data-session-directory={dir()}
      data-session-first-fold-ready={firstFoldReady() ? "true" : "false"}
      data-session-messages-ready={messagesReady() ? "true" : "false"}
      data-session-message-count={String(messages().length)}
      data-session-conversation-count={String(messages().length)}
      data-session-visible-user-count={String(visibleUserMessages().length)}
      data-session-rendered-user-count={String(historyWindow.renderedUserMessages().length)}
      data-session-info-title={resolvedTitle() ?? ""}
    >
      <SessionHeader />
      <div class="flex-1 min-h-0 flex flex-col">
        <div class="@container relative flex-1 flex flex-col min-h-0 h-full bg-background-stronger pt-2 md:pt-3">
          <div class="flex-1 min-h-0 overflow-hidden">
            <Switch>
              <Match when={gate.open}>
                <NewSessionDesignView
                  worktree={newSessionWorktree()}
                  workspaceKind="cloud"
                  onWorktreeChange={changeNewSessionWorktree}
                  onWorkspaceKindChange={setNewSessionWorkspaceKind}
                  onAddProject={addProject()}
                  signedControlPlane={signedControlPlane()}
                  sandboxEnabled={config?.sandboxEnabled}
                  main={
                    <div class="flex min-h-[280px] items-center justify-start px-2">
                      <CloudStartupView
                        status={gate.status}
                        err={gate.err}
                        logs={gate.logs}
                        variant={gate.variant}
                        forbidden={gateForbidden()}
                        onGoToWorkspaces={() => navigate("/")}
                      />
                    </div>
                  }
                >
                  <div />
                </NewSessionDesignView>
              </Match>
              <Match when={sessionID() && sessionID() !== "new"}>
                <Show keyed when={sessionID() && sessionID() !== "new" ? sessionID() : undefined}>
                  {(id) => (
                    <SessionConversationOwner
                      directory={dir()}
                      sessionId={id}
                      messages={() => undefined}
                      parts={() => undefined}
                    />
                  )}
                </Show>
                <Show
                  when={!sessionMissing()}
                  fallback={
                    <div class="flex h-full items-center justify-center px-4 text-text-weak">
                      <div data-testid="session-unavailable" data-session-id={sessionID() ?? ""}>
                        Session unavailable
                      </div>
                    </div>
                  }
                >
                  <Show
                    keyed
                    when={timelineMountSessionKey({
                      messagesReady: messagesReady(),
                      sessionKey: sessionKey(),
                    })}
                    fallback={
                      <div
                        class="size-full bg-background-base"
                        data-session-timeline-loading
                        data-testid="session-messages-loading"
                      />
                    }
                  >
                    {(_id) => (
                      <MessageTimeline
                        active={paneActive}
                        actions={actions()}
                        title={resolvedTitle}
                        directorySessions={directorySessions}
                        workspaceId={routeIdForDirectory(dir())}
                        sessionRef={activeSessionRef()}
                        parentID={info()?.parentID}
                        onNavigateParent={navigateParent}
                        scroll={ui.scroll}
                        onResumeScroll={resumeScroll}
                        setScrollRef={setScrollRef}
                        onScheduleScrollState={scheduleScrollState}
                        onAutoScrollHandleScroll={autoScroll.handleScroll}
                        onMarkScrollGesture={markScrollGesture}
                        hasScrollGesture={hasScrollGesture}
                        onUserScroll={markUserScroll}
                        onHistoryScroll={historyWindow.onScrollerScroll}
                        onAutoScrollInteraction={autoScroll.handleInteraction}
                        shouldAnchorBottom={() =>
                          !paneLocation().hash && !store.messageId && !ui.pendingMessage && !autoScroll.userScrolled()
                        }
                        centered={centered()}
                        setContentRef={(el) => {
                          content = el
                          autoScroll.contentRef(el)

                          const root = scroller
                          if (root) scheduleScrollState(root)
                        }}
                        historyShift={false}
                        userMessages={historyWindow.renderedUserMessages()}
                        navMessages={visibleUserMessages()}
                        currentMessage={activeMessage()}
                        onMessageSelect={(message) => {
                          autoScroll.pause()
                          scrollToMessage(message)
                        }}
                        status={sessionController.status}
                        anchor={anchor}
                        setScrollToEnd={(fn) => {
                          scrollToEnd = fn
                        }}
                        setScrollToMessage={(fn) => {
                          scrollToTimelineMessage = fn ?? (() => false)
                        }}
                        setHistoryAnchor={(handlers) => {
                          captureHistoryAnchor = handlers.capture
                          restoreHistoryAnchor = handlers.restore
                        }}
                        onFirstTurnRecovery={(kind, userMessageID) =>
                          firstTurnOnboarding.recover(kind, draft(userMessageID))}
                        firstTurnRecovery={!directorySessions().some((session) => session.id !== sessionID() && session.lastTurn)}
                      />
                    )}
                  </Show>
                </Show>
              </Match>
              <Match when={newSessionComposerReady()}>
                <NewSessionDesignView
                  worktree={newSessionWorktree()}
                  workspaceKind={store.newSessionWorkspaceKind}
                  branch={newSessionBranch()} branches={newSessionBranchSource.choices()} branchState={newSessionBranchSource.state().status} onBranchChange={newSessionBranchSource.select}
                  onWorktreeChange={changeNewSessionWorktree}
                  onWorkspaceKindChange={setNewSessionWorkspaceKind}
                  onAddProject={addProject()}
                  signedControlPlane={signedControlPlane()}
                  sandboxEnabled={config?.sandboxEnabled}
                  onProjectChange={(target, project) => {
                    if (target === dir()) return
                    const workspaceId = workspaceRouteId([project], target)
                    if (!workspaceId) return
                    layout.projects.open(target)
                    groupNavigate(workspaceSessionRoute(workspaceId), target)
                  }}
                >
                  <PromptInput
                    mode={composerModes.draft()}
                    harnessSubmitController={promptHarnessControllers.submit}
                    harnessSelectionController={promptHarnessControllers.selection}
                    ref={(el) => {
                      inputRef = el
                    }}
                    variant="new-session"
                    canPrompt={() => supports("permissions")}
                    newSessionWorktree={newSessionWorktree()}
                    newSessionBaseRef={newSessionBaseRef()}
                    newSessionSourceBranch={newSessionSourceBranch()}
                    newSessionWorkspaceKind={store.newSessionWorkspaceKind}
                    onNewSessionWorktreeReset={() => setStore("newSessionWorktree", "main")}
                    onCloudStartup={(state) => {
                      if (!state) {
                        resetGate()
                        return
                      }
                      setGate({
                        open: true,
                        sync: state.sync ?? false,
                        id: state.id,
                        status: state.status,
                        err: state.err,
                        logs: state.logs ?? [],
                        variant: "cloud",
                      })
                    }}
                    system={contentIntentDefaults()?.system}
                    agent={contentIntentDefaults()?.agent}
                    status={sessionController.status}
                    activeTurn={sessionController.activeTurn}
                    diffFiles={diffFiles} sessionDirectory={dir()}
                    sessionRef={activeSessionRef}
                    signedControlPlane={signedControlPlane}
                    workspaceId={signedWorkspaceId}
                    workspaceKind={resolvedWorkspaceKind}
                    onSubmit={() => {
                      comments.clear()
                      resumeScroll()
                    }}
                  />
                </NewSessionDesignView>
              </Match>
            </Switch>
          </div>

          <Show when={!gate.open && !newSession()}>
            <Suspense fallback={<div aria-hidden="true" class="h-44 shrink-0" data-component="session-prompt-dock-loading" />}>
              <SessionComposerRegion
              state={composerState}
              ready={!store.deferRender && messagesReady()}
              centered={centered()}
              sessionID={sessionID()}
              parentID={info()?.parentID}
              onNavigateParent={navigateParent}
              mode={composerModes.current()}
              system={contentIntentDefaults()?.system}
              agent={contentIntentDefaults()?.agent}
              canAbort={() => supports("abort")}
              canPrompt={() => supports("permissions")}
              status={sessionController.status}
              activeTurn={sessionController.activeTurn}
              beforeInput={
                <DeferredSessionSecondaryStatus
                  active={sessionParams.active}
                  firstFoldReady={firstFoldReady}
                  directory={dir}
                  sessionId={sessionID}
                  workspaceId={signedWorkspaceId}
                />
              }
              registerRetry={firstTurnOnboarding.registerRetry}
              sessionDirectory={dir()}
              sessionRef={activeSessionRef}
              signedControlPlane={signedControlPlane}
              workspaceId={signedWorkspaceId}
              workspaceKind={resolvedWorkspaceKind}
              inputRef={(el) => {
                inputRef = el
              }}
              newSessionWorktree={newSessionWorktree()}
              onNewSessionWorktreeReset={() => setStore("newSessionWorktree", "main")}
              onSubmit={() => {
                comments.clear()
                resumeScroll()
              }}
              onResponseSubmit={() => {
                resumeScroll()
              }}
              revert={
                rolled().length > 0
                  ? {
                      items: rolled(),
                      restoring: ui.restoring,
                      onRestore: restore,
                    }
                  : undefined
              }
              setPromptDockRef={(el) => (promptDock = el)}
              />
            </Suspense>
          </Show>
        </div>
      </div>
    </div>
  )
}
