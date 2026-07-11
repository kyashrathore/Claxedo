// Claxedo sessions can render inside independent Workbench panes, so this override uses pane-scoped params, cloud runtime gates, and the inline new-session composer.
import {
  onCleanup,
  onMount,
  Show,
  Match,
  Switch,
  createMemo,
  createEffect,
  createComputed,
  on,
} from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useQuery } from "@tanstack/solid-query"
import { useLocal } from "@/context/session-selection"
import { createStore } from "solid-js/store"
import { createAutoScroll } from "@opencode-ai/ui/hooks"

import { useTerminal } from "@/context/terminal"
import { useLayout } from "@/context/layout"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useLocation, useNavigate } from "@solidjs/router"
import { UserMessage, type SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { useSDK } from "@/context/sdk"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePrompt } from "@/context/prompt"
import { useComments } from "@/context/comments"
import { useServer } from "@/context/server"
import { useShellQueryOptions as useQueryOptions } from "@/shell/data/query-options"
import { showToast } from "@opencode-ai/ui/toast"
import { NewSessionDesignView, SessionHeader, type NewSessionWorkspaceKind } from "@/components/session"
import { createNewSessionWorkspaceState, type ProjectWorkspace } from "../components/session/session-new-workspace-options"
import { PromptInput } from "@/session/composer/composer"
import { same } from "@/utils/same"
import { extractPromptFromParts } from "@/shared/data/prompt"
import { createSessionHistoryWindow, emptyUserMessages } from "./session/history-window"
import { groupNavigateUrlSync } from "./session/group-navigate-route"
import { setSessionHandoff, setTerminalHandoff } from "./session/prompt-preview-handoff"
import { terminalTabLabel } from "./session/terminal-label"
import { MessageTimeline } from "./session/message-timeline"
import { useSessionCommands } from "./session/use-session-commands"
import { SessionComposerRegion, createSessionComposerState } from "./session/composer"
import { useSessionHashScroll } from "./session/use-session-hash-scroll"
import { useSessionParams } from "../claxedo-ui/context/session-params"
import { usePaneId } from "../claxedo-ui/context/pane-id"
import { useClaxedoState } from "../claxedo-ui/state"
import { useClaxedoEventsOptional } from "../context/claxedo-events"
import { CloudStartupView, isForbiddenConnectionError, type CloudLog } from "@/components/session/cloud-startup-view"
import { resolveSessionDirectory, resolveSessionIdentity, resolveSignedSessionWorkspaceId, signedProjectWorkspaceId, type SessionIdentity } from "./session/session-identity"
import {
  shouldDispatchIdleAfterStaleBusyRefresh,
  shouldReconcileBusySessionToIdle,
  sessionFirstFoldReady,
  sessionMessagesReady,
  shouldRenderNewSessionComposer,
  sessionSwitchResetPlan,
  sessionUserMessages,
  stableSessionInfo,
  stableSessionMessages,
  staleBusyReconciliationKey,
  timelineMountSessionKey,
  visibleSessionUserMessages,
} from "./session/view-state"
import { createSessionController } from "../session/store/session-controller"
import { sameWorkspaceDirectory, signedWorkspaceFromProjects } from "../agent-runtime/signed-workspace"
import { getClaxedoServerUrl } from "@/shared/data/api"
import { principalHasSignedAccess, usePrincipal } from "../shell/auth/identity-provider"
import { placementFor } from "../shell/auth/placement"
import { parseShellRoute, sessionRoute, shellRouteDirectory, workspaceSessionRoute } from "../shell/identity/route"
import { sessionViewKey, terminalScopeKey } from "../shell/identity/session-view-key"
import { shellDataKeys } from "../shell/data/keys"
import { sessionWorkspaceRuntimeRef } from "../shell/workspace/session-workspace-key"
import { isWorkspaceReady } from "../shell/workspace/workspace-connection"
import { retargetSessionRef } from "../shell/identity/session-ref"
import { SessionConversationOwner } from "../shell/chat/session-conversation-owner"
import { registeredConversationSnapshot } from "../shell/chat/conversation-registry"
import { removeDirectorySession, updateDirectorySession, useDirectorySessionCacheActions } from "../shell/data/directory-session-cache"
import {
  directorySessionCacheQueryOptions,
  emptySessionInventory,
  sessionInventoryQueryOptions,
} from "../shell/data/queries"
import { queryClient } from "../shared/query/query-client"
import { dispatchSessionStatusEvent } from "../session/store/session-status-dispatcher"
import type { SessionInventoryRow } from "../shared/query/types"
import { createSessionComposerModes } from "./session/composer/session-composer-mode"
import { createNewSessionDeepLinkPromptSeed } from "./session/composer/deep-link-prompt"
import { assistantMessageIdForUserMessage, type ClaxedoSession } from "../shared/data/session-types"
import { usePromptHarnessControllersOptional } from "../components/prompt-input/harness-controller"
import { emptyTitleEditorState, openTitleEditorPatch, resolveTitleSave } from "./session/session-title-editor"
import { nextSiblingAfterRemoval, sessionRemovalNavigation } from "./session/session-archive"
import { previewPromptText } from "./session/prompt-preview"
import { buildDiffKindTree } from "./session/diff-kind-tree"
import { computeScrollState, pickAnchorMessageId } from "./session/scroll-anchor"
import { classifySessionKeydown, isEditableTagName } from "./session/session-keydown"

export default function SessionPage() {
  const sessionParams = useSessionParams()
  const claxedoState = useClaxedoState()
  const paneId = usePaneId()
  const layout = useLayout()
  const local = useLocal()
  const server = useServer()
  const terminal = useTerminal()
  const dialog = useDialog()
  const language = useLanguage()
  const navigate = useNavigate()
  const location = useLocation()
  const sdk = useSDK()
  const globalSDK = useGlobalSDK()
  const prompt = usePrompt()
  const comments = useComments()
  const promptHarnessControllers = usePromptHarnessControllersOptional()

  const activeContentMeta = createMemo(() => {
    const surfaceId = sessionParams.surfaceId?.()
    if (!surfaceId) return
    return claxedoState.meta.get(surfaceId)
  })
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
  const routeSessionDirectory = createMemo(() => { const route = parseShellRoute(location.pathname); return route.kind === "workspace-session" ? route.workspaceId : undefined })
  const terminalHandoffKey = createMemo(() => terminalScopeKey(routeDirectory()))
  const sessionInventoryQuery = useQuery(() =>
    sessionInventoryQueryOptions<SessionInventoryRow>({
      baseUrl: globalSDK.url,
    }),
  )
  const sessionInventory = createMemo(() =>
    sessionInventoryQuery.data ?? emptySessionInventory<SessionInventoryRow>(),
  )
  const inventorySession = createMemo(() => {
    const id = sessionID()
    if (!id) return
    const inventory = sessionInventory()
    return inventory.global.find((session) => session.id === id) ??
      Object.values(inventory.byProject).flat().find((session) => session.id === id) ??
      Object.values(inventory.byWorkspace).flatMap((group) => group.sessions).find((session) => session.id === id)
  })
  const dir = createMemo(() => resolveSessionDirectory({
    routeDirectory: routeDirectory(),
    sessionRef: activeSessionRef(),
    inventoryDirectory: inventorySession()?.directory,
  }))
  const queryOptions = useQueryOptions()
  const projectsQuery = useQuery(() => queryOptions.projects())
  const projects = createMemo(() => projectsQuery.data ?? [])
  const directorySessionCacheQuery = useQuery(() =>
    directorySessionCacheQueryOptions({
      directory: dir(),
    }),
  )
  const directorySessions = createMemo(() => directorySessionCacheQuery.data?.session ?? [])
  const directorySession = (sessionID: string | undefined) =>
    sessionID ? directorySessions().find((session) => session.id === sessionID) : undefined
  const updateDirectorySessionCacheRow = (sessionID: string, update: (session: ClaxedoSession) => ClaxedoSession) => {
    updateDirectorySession(dir(), sessionID, update)
  }
  const directorySessionCacheActions = useDirectorySessionCacheActions()
  const principal = usePrincipal()
  const events = useClaxedoEventsOptional()
  const sameDirectory = (left?: string, right?: string) => {
    return sameWorkspaceDirectory(left, right)
  }
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
    const workspace = sdk.workspace(dir()) ?? ws()
    const kind = workspace?.kind
    const cwd = dir()
    const placement = placementFor({
      ref: activeSessionRef(),
      hasSignedAccess: principalHasSignedAccess(principal()),
      serverUrl: getClaxedoServerUrl(),
      legacy: {
        directory: cwd,
        workspaceKind: kind,
      },
    })
    return !!placement && placement.transport !== "loopback"
  })
  const signedWorkspaceId = createMemo(() =>
    resolveSignedSessionWorkspaceId({
      signedControlPlane: signedControlPlane(),
      routeDirectory: routeSessionDirectory(),
      inventoryWorkspaceId: inventorySession()?.workspaceId,
      projectWorkspaceId: signedProjectWorkspaceId({
        signedWorkspace: signedWorkspaceFromProjects(projects(), dir()),
        workspace: ws() as { id?: string; workspaceId?: string; kind?: string } | undefined,
      }),
      workspaceId: sessionWorkspaceRuntimeRef({ directory: dir() })?.workspaceId,
    }),
  )
  const replayWorkspaceId = createMemo(() => inventorySession()?.workspaceId ?? signedWorkspaceId() ?? ((sdk.workspace(dir()) ?? ws()) as { id?: string; workspaceId?: string } | undefined)?.workspaceId ?? ((sdk.workspace(dir()) ?? ws()) as { id?: string; workspaceId?: string } | undefined)?.id)
  // The split "New Session" pane resolves `ws()` from activeProject(), which
  // often does NOT contain the workspace — leaving kind undefined. The fallback
  // `sessionWorkspaceRuntimeRef` then HARDCODES kind:"cloud", so a user-hosted
  // workspace wrongly enters the cloud sandbox-acquisition flow in the second
  // pane ("Acquiring sandbox / Queueing sandbox") while the route pane correctly
  // shows the user-hosted "Checking runtime health" flow. Resolve the real
  // access kind from the full signed inventory (projects()), which carries it,
  // so every pane agrees on cloud vs user-hosted.
  const resolvedWorkspaceKind = createMemo<"cloud" | "user-hosted" | undefined>(() => {
    const inventoryKind = inventorySession()?.environment?.kind
    if (inventoryKind === "cloud" || inventoryKind === "user-hosted") return inventoryKind
    const kind = ws()?.kind
    if (kind === "cloud" || kind === "user-hosted") return kind
    const cwd = dir()
    // Match the inventory by directory first, then by the workspace id encoded
    // in a `workspace:<id>` ref — the split pane's `dir()` is often the id-ref
    // form, which `signedWorkspaceFromProjects` won't match as a directory.
    const fromDirectory = signedWorkspaceFromProjects(projects(), cwd)?.kind
    if (fromDirectory) return fromDirectory
    const workspaceId = sessionWorkspaceRuntimeRef({ directory: cwd })?.workspaceId
    return workspaceId ? signedWorkspaceFromProjects(projects(), workspaceId)?.kind : undefined
  })
  const routeWorkspaceKind = createMemo<NewSessionWorkspaceKind>(() => {
    const kind = resolvedWorkspaceKind()
    // Carry user-hosted through as its own kind (was collapsed to "cloud", which
    // dropped the self-hosted workspace into the cloud-provision composer). The
    // submit path still treats it as an existing remote workspace (connect, never
    // provision) — see resolve.ts — but the composer now presents it correctly.
    if (kind === "user-hosted") return "user-hosted"
    if (kind === "cloud") return "cloud"
    return sessionWorkspaceRuntimeRef({ directory: dir() }) ? "cloud" : "local"
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
    if (!directorySessionCacheQuery.data) return
    setGate("open", false)
    setGate("sync", false)
    setGate("err", undefined)
  })

  // Cloud: group-aware navigation helper.
  //
  // In-pane retargets (openSession) keep the pane mounted, but the reverse
  // surface→URL sync refuses to touch session/workspace-kind routes, so a switch
  // into a DIFFERENT workspace/directory would leave the URL pinned to the prior
  // workspace (a reload would then restore the wrong surface). Sync the URL to the
  // target ONLY when its directory differs from the current URL — a replace nav
  // that route-intent resolves back onto the already-open pane, never a remount.
  const syncGroupNavigateUrl = (path: string) => {
    if ((window as unknown as { __NOSYNC__?: boolean }).__NOSYNC__) return
    const sync = groupNavigateUrlSync({ targetPath: path, currentPathname: location.pathname })
    if (sync) navigate(sync, { replace: true })
  }

  // Cloud: group-aware navigation helper
  const groupNavigate = (path: string) => {
    const gid = sessionParams.paneId() ?? paneId
    const current = sessionParams.directory()
    if (gid && current && claxedoState) {
      const route = parseShellRoute(path)
      const routeDir = shellRouteDirectory(route)
      const dir = routeDir ?? current
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
    groupNavigate(workspaceSessionRoute(directory))
  }

  const sessionController = createSessionController({
    directory: dir,
    sessionID: () => sessionID(),
    serverHealthy: () => server.healthy(),
    active: () => sessionParams.active?.() ?? true,
    signedControlPlane,
    workspaceId: replayWorkspaceId,
    workspaceKind: resolvedWorkspaceKind,
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
  createEffect(() => {
    const meta = activeContentMeta()
    const id = sessionID()
    const next = (info()?.title ?? inventorySession()?.title)?.trim()
    if (sessionParams.active?.() === false || !meta || meta.type !== "session" || !id || meta.sessionId !== id || !next) return
    if (meta.content?.title === next) return
    claxedoState.meta.patch(meta.id, {
      content: {
        ...meta.content,
        type: "session",
        directory: meta.directory,
        sessionId: id,
        title: next,
      },
    })
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
  const conversation = createMemo(() => registeredConversationSnapshot(sessionID()))
  const sessionMissing = createMemo(() => sessionController.missing())
  const messagesReady = createMemo(() =>
    sessionMessagesReady({
      sessionId: sessionID(),
      sessionMissing: sessionMissing(),
      messagesLoaded: messageState()?.value !== undefined,
    }),
  )
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

    setTitle("saving", true)
    await sdk.client.session
      .update({ sessionID: currentSessionID, title: next })
      .then(() => {
        updateDirectorySessionCacheRow(currentSessionID, (session) => ({ ...session, title: next }))
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
        if (nav.kind === "root") groupNavigate(workspaceSessionRoute(dir()))
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
  createNewSessionDeepLinkPromptSeed({ newSession, search: () => location.search, prompt, replaceSearch: (search) => navigate(`${location.pathname}${search}${location.hash}`, { replace: true }) })
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
    setStore("newSessionControlsTouched", true)
    setStore("newSessionWorkspaceKind", value)
    if (newSessionWorktree() === "create") {
      return
    }
    if (newSessionWorkspaceOptions(value).includes(newSessionWorktree())) return
    setStore("newSessionWorktree", newSessionWorkspaceOptions(value)[0] ?? (value === "cloud" ? "create" : "main"))
  }
  const changeNewSessionWorktree = (value: string) => {
    setStore("newSessionControlsTouched", true)
    if (value === "create") {
      setStore("newSessionWorktree", value)
      return
    }

    setStore("newSessionWorktree", "main")

    const target = value === "main" ? activeProject()?.worktree : value
    if (!target) return
    if (target === dir()) return
    layout.projects.open(target)
    groupNavigate(workspaceSessionRoute(target))
  }

  let inputRef!: HTMLDivElement
  let promptDock: HTMLDivElement | undefined
  let dockHeight = 0
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

  const isEditableTarget = (target: EventTarget | null | undefined) => {
    if (!(target instanceof HTMLElement)) return false
    return isEditableTagName(target.tagName) || target.isContentEditable
  }

  const deepActiveElement = () => {
    let current: Element | null = document.activeElement
    while (current instanceof HTMLElement && current.shadowRoot?.activeElement) {
      current = current.shadowRoot.activeElement
    }
    return current instanceof HTMLElement ? current : undefined
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    const path = event.composedPath()
    const target = path.find((item): item is HTMLElement => item instanceof HTMLElement)
    const activeElement = deepActiveElement()

    const protectedTarget = path.some(
      (item) => item instanceof HTMLElement && item.closest("[data-prevent-autofocus]") !== null,
    )
    if (protectedTarget || isEditableTarget(target)) return

    if (activeElement) {
      const isProtected = activeElement.closest("[data-prevent-autofocus]")
      const isInput = isEditableTarget(activeElement)
      if (isProtected || isInput) return
    }
    if (dialog.active) return

    if (activeElement === inputRef) {
      if (event.key === "Escape") inputRef?.blur()
      return
    }

    // Only treat explicit scroll keys as potential "user scroll" gestures.
    const action = classifySessionKeydown(event)
    if (action === "scroll-gesture") {
      markScrollGesture()
      return
    }

    if (action === "focus-input") {
      if (composerState.blocked()) return
      inputRef?.focus()
    }
  }

  const fileTreeTab = () => layout.fileTree.tab()
  const setFileTreeTab = (value: "changes" | "all") => layout.fileTree.setTab(value)

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    setFileTreeTab("all")
  }

  const focusInput = () => inputRef?.focus()

  useSessionCommands({
    sessionId: sessionID,
    directory: dir,
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
        if (location.hash || store.messageId || ui.pendingMessage) return
        autoScroll.resume()
      },
    ),
  )

  let scrollStateFrame: number | undefined
  let scrollStateTarget: HTMLDivElement | undefined
  let historyFillFrame: number | undefined
  let scrollToEnd = () => {}

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
    setStore("messageId", undefined)
    autoScroll.resume()
    scrollToEnd()
    clearMessageHash()

    const el = scroller
    if (el) scheduleScrollState(el)
  }

  // When the user returns to the bottom, treat the active message as "latest".
  createEffect(
    on(
      autoScroll.userScrolled,
      (scrolled) => {
        if (scrolled) return
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
  })

  const scheduleHistoryFill = () => {
    if (historyFillFrame !== undefined) return

    historyFillFrame = requestAnimationFrame(() => {
      historyFillFrame = undefined

      if (!sessionID() || !messagesReady()) return
      if (autoScroll.userScrolled() || historyLoading()) return

      const el = scroller
      if (!el) return
      if (el.scrollHeight > el.clientHeight + 1) return
      if (historyWindow.turnStart() <= 0 && !historyMore()) return

      void historyWindow.loadAndReveal()
    })
  }

  createEffect(
    on(
      sessionKey,
      () => {
        const plan = sessionSwitchResetPlan({
          locationHash: location.hash,
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

  createResizeObserver(
    () => promptDock,
    ({ height }) => {
      const next = Math.ceil(height)
      if (next === dockHeight) return

      const el = scroller
      const delta = next - dockHeight
      const stick = el
        ? !autoScroll.userScrolled() || el.scrollHeight - el.clientHeight - el.scrollTop < 10 + Math.max(0, delta)
        : false

      dockHeight = next

      if (stick) scrollToEnd()

      if (el) scheduleScrollState(el)
      scheduleHistoryFill()
    },
  )

  const draft = (id: string) =>
    extractPromptFromParts(conversation().parts[id] ?? [], {
      directory: sdk.directory,
      attachmentName: language.t("common.attachment"),
    })

  const line = (id: string) => {
    const text = draft(id)
      .map((part) => (part.type === "image" ? `[image:${part.filename}]` : part.content))
      .join("")
      .replace(/\s+/g, " ")
      .trim()
    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const fail = (err: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: errorMessage(err),
    })
  }

  const busy = () => sessionController.activeTurn()

  const supports = (name: keyof ReturnType<typeof sessionController.capabilities>) =>
    sessionController.capabilities()[name] !== false

  const halt = (sessionID: string) =>
    busy() && supports("abort") ? sdk.client.session.abort({ sessionID }).catch(() => {}) : Promise.resolve()

  const fork = (input: { sessionID: string; messageID: string }) => {
    if (!supports("fork")) return Promise.resolve()
    const value = draft(input.messageID)
    return sdk.client.session
      .fork(input)
      .then((result) => {
        const next = result.data
        if (!next) {
          showToast({
            variant: "error",
            title: language.t("common.requestFailed"),
          })
          return
        }
        navigateSession(next.id)
        requestAnimationFrame(() => {
          prompt.set(value)
        })
      })
      .catch(fail)
  }

  const revert = (input: { sessionID: string; messageID: string }) => {
    if (!supports("revert")) return Promise.resolve()
    const value = draft(input.messageID)
    return halt(input.sessionID)
      .then(() => sdk.client.session.revert(input))
      .then(() => {
        prompt.set(value)
      })
      .catch(fail)
  }

  const restore = (id: string) => {
    const currentSessionID = sessionID()
    if (!currentSessionID || ui.restoring) return

    const next = userMessages().find((item) => item.id > id)
    setUi("restoring", id)

    const task = !next
      ? !supports("unrevert")
        ? Promise.resolve()
        : halt(currentSessionID)
            .then(() => sdk.client.session.unrevert({ sessionID: currentSessionID }))
            .then(() => {
              prompt.reset()
            })
      : !supports("revert")
        ? Promise.resolve()
        : halt(currentSessionID)
            .then(() =>
              sdk.client.session.revert({
                sessionID: currentSessionID,
                messageID: next.id,
              }),
            )
            .then(() => {
              prompt.set(draft(next.id))
            })

    return task.catch(fail).finally(() => {
      setUi("restoring", (value) => (value === id ? undefined : value))
    })
  }

  const rolled = createMemo(() => {
    const id = revertMessageID()
    if (!id) return []
    return userMessages()
      .filter((item) => item.id >= id)
      .map((item) => ({ id: item.id, text: line(item.id) }))
  })

  const actions = createMemo(() => ({
    ...(supports("fork") ? { fork } : {}),
    ...(supports("revert") ? { revert } : {}),
  }))

  const { clearMessageHash, scrollToMessage } = useSessionHashScroll({
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
    anchor,
    scheduleScrollState,
    consumePendingMessage: layout.pendingMessage.consume,
  })

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown)
  })

  createEffect(() => {
    if (!prompt.ready()) return
    setSessionHandoff(sessionKey(), { prompt: previewPromptText(prompt.current()) })
  })

  createEffect(() => {
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
    if (historyFillFrame !== undefined) cancelAnimationFrame(historyFillFrame)
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
      data-session-conversation-count={String(conversation().messages.length)}
      data-session-visible-user-count={String(visibleUserMessages().length)}
      data-session-rendered-user-count={String(historyWindow.renderedUserMessages().length)}
      data-session-info-title={info()?.title ?? inventorySession()?.title ?? ""}
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
                    when={timelineMountSessionKey({ messagesReady: messagesReady(), sessionKey: sessionKey() })}
                    fallback={
                      <div class="flex h-full items-start justify-center px-4 pt-12 text-text-weak">
                        <div
                          class="flex h-20 w-full max-w-[720px] items-center justify-center gap-2 rounded-md border border-border-weak-base bg-background-base/60"
                          data-testid="session-messages-loading"
                        >
                          <div class="size-4 shrink-0 animate-spin rounded-full border border-border-base border-t-transparent" />
                          <span class="text-13-regular text-text-weak">Loading session</span>
                        </div>
                      </div>
                    }
                  >
                    {(_id) => (
                      <MessageTimeline
                        actions={actions()}
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
                          !location.hash && !store.messageId && !ui.pendingMessage && !autoScroll.userScrolled()
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
                        status={sessionController.status}
                        anchor={anchor}
                        setScrollToEnd={(fn) => {
                          scrollToEnd = fn
                        }}
                        setHistoryAnchor={(handlers) => {
                          captureHistoryAnchor = handlers.capture
                          restoreHistoryAnchor = handlers.restore
                        }}
                      />
                    )}
                  </Show>
                </Show>
              </Match>
              <Match when={newSessionComposerReady()}>
                <NewSessionDesignView
                  worktree={newSessionWorktree()}
                  workspaceKind={store.newSessionWorkspaceKind}
                  onWorktreeChange={changeNewSessionWorktree}
                  onWorkspaceKindChange={setNewSessionWorkspaceKind}
                  onProjectChange={(target: string) => {
                    if (target === dir()) return
                    layout.projects.open(target)
                    groupNavigate(workspaceSessionRoute(target))
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
                    newSessionWorktree={newSessionWorktree()}
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
            <SessionComposerRegion
              state={composerState}
              ready={!store.deferRender && messagesReady()}
              centered={centered()}
              sessionID={sessionID()}
              mode={composerModes.current()}
              system={contentIntentDefaults()?.system}
              agent={contentIntentDefaults()?.agent}
              canAbort={() => supports("abort")}
              status={sessionController.status}
              activeTurn={sessionController.activeTurn}
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
          </Show>
        </div>
      </div>
    </div>
  )
}
