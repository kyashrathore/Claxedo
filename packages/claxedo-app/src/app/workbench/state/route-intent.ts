/**
 * Route intent adapter — URL → workbench state.
 *
 * URL changes open or focus the requested workspace, session, page, or terminal.
 * Direct workbench actions publish the reverse direction through surfaceRoute()
 * in the app shell.
 *
 * ## Invariants
 *
 * I1. Deep-link to an existing session (dir, sessionId) focuses that content
 *     and does NOT create a duplicate.
 * I2. Deep-link to an unknown sessionId creates exactly ONE content keyed to
 *     that sessionId, never a phantom "new" content.
 * I3. Workspace session root (/w/:workspaceId/session with no sessionId/pageId) focuses
 *     or creates the workspace-scoped "new session" content.
 * I4. Workspace session root must not keep a stale focused content from a
 *     different workspace.
 * I5. Page deep-link resolves to a matching page-kind content:
 *       - __index__    → pages-index content
 *       - <pageId>     → page content with that id
 *     Existing entries are reused; new ones are created if absent.
 * I6. Deep-link to a page with a stale sessionId on the existing content
 *     clears that sessionId during activation (the URL is authoritative).
 * I7. A focused "context" content for the same workspace is preserved when
 *     a session deep-link arrives — we activate the session content in state
 *     but keep the context content as the focused one so the user's
 *     in-flight context view isn't stolen by a background URL update.
 */
import type { Accessor } from "solid-js"
import { sessionPerf } from "@/platform/performance/session-perf"
import { workspaceSessionRoute, workspaceTerminalRoute, type TasksPage } from "@/platform/identity/route"
import { sameSessionRef, sessionRefForWorkspaceSession, type SessionRef, type WorkspaceSessionBacking } from "@/platform/identity/session-ref"
import type { ClaxedoStateApi } from "./provider"
import type { ContentMeta } from "./types"
import { routeSessionHarness } from "./route-session-harness"
import { isNarrowViewport } from "../workbench/index"
import { isRouteIntentClosed, markRouteIntentClosed } from "./route-bridge-resolution"
import { isRelayBackedWorkspaceKind, workspaceKind } from "@/platform/runtime/agent/workspace-kind"
export {
  CLOSED_ROUTE_MAX,
  isRouteIntentClosed,
  markRouteIntentClosed,
  resetRouteIntentClosedForTest,
  routeIntentClosedSizeForTest,
} from "./route-bridge-resolution"

type Badge = {
  additions: number
  deletions: number
}

export type RouteIntent = {
  ready: boolean
  marketplace: boolean
  tasks: boolean
  /** The nested Tasks page the URL names; absent is the task list. */
  tasksPage: TasksPage | undefined
  workspaceId: string | undefined
  workspaceRouteId?: string
  workspaceBacking?: WorkspaceSessionBacking
  sessionId: string | undefined
  pageId: string | undefined
  terminalId: string | undefined
  workspaceBrowse: boolean
  sessionTitle: string
  sessionBadge: Badge | undefined
}

type RouteIntentInventorySession = {
  id?: string
  archived?: boolean
  workspaceId?: string
  directory?: string
  title?: string
  tags?: unknown
  sessionRef?: string
  environment?: { kind?: string }
  harness?: unknown
  runner?: unknown
  config?: unknown
  harnessType?: unknown
}

export type RouteIntentInventory = {
  global?: RouteIntentInventorySession[]
  byWorkspace: Record<
    string,
    { key?: string; workspaceId?: string; directory?: string; sessions?: RouteIntentInventorySession[] }
  >
  byProject: Record<string, RouteIntentInventorySession[]>
  loaded?: boolean
}

const ROUTE_INTENT_INDEX = "__index__"
type InventorySessionTarget = { directory: string; title: string | undefined; sessionRef: SessionRef | undefined }
type ResolvedSessionTarget = {
  directory: InventorySessionTarget["directory"]
  title?: string
  workspaceId?: string
  environment?: { kind?: string }
  sessionRef?: SessionRef
}
export type UnavailableSessionTarget = {
  unavailable: true
  redirect?: string
}
type SessionRouteResolution =
  | { state: "resolving" }
  | { state: "workspace"; target: InventorySessionTarget }
  | { state: "unresolved" }

export type RouteIntentStateApi = Pick<ClaxedoStateApi, "wb" | "meta" | "layout" | "workspacePanel" | "terminal">

function workspaceBacking(input: { workspaceId?: string; kind?: string }): WorkspaceSessionBacking | undefined {
  const kind = workspaceKind(input.kind)
  if (!input.workspaceId || !isRelayBackedWorkspaceKind(kind)) return undefined
  return {
    workspaceId: input.workspaceId,
    kind,
  }
}

function workspaceRootBacking(workspaceId: string, inventory: RouteIntentInventory | undefined) {
  const group = Object.values(inventory?.byWorkspace ?? {}).find((item) =>
    item.workspaceId === workspaceId ||
    item.key === workspaceId ||
    item.directory === workspaceId
  )
  const rootWorkspaceId = group?.workspaceId ?? workspaceId
  return group?.sessions
    ?.map((session) => workspaceBacking({
      workspaceId: rootWorkspaceId,
      kind: session.environment?.kind,
    }))
    .find((backing): backing is WorkspaceSessionBacking => !!backing)
}

export function sessionInventoryTarget(sessionId: string, inventory: RouteIntentInventory) {

  const workspaceMatches = Object.entries(inventory.byWorkspace)
    .filter(([, group]) => group.sessions?.some((session) => session.id === sessionId && !session.archived))
    .map(([key, group]): InventorySessionTarget => {
      const session = group.sessions?.find((session) => session.id === sessionId && !session.archived)
      const backing = workspaceBacking({
        workspaceId: group.workspaceId,
        kind: session?.environment?.kind,
      })
      const directory =
        backing?.workspaceId ??
        (group.directory && group.directory !== "/workspace" ? group.directory : undefined) ??
        session?.directory ??
        (group.key && group.key !== "/workspace" ? group.key : undefined) ??
        key
      const harness = routeSessionHarness(session)
      return {
        directory,
        title: session?.title,
        sessionRef: sessionRefForWorkspaceSession({
          sessionId,
          directory,
          workspace: backing,
          ...(harness ? { harness } : {}),
        }),
      }
    })
  const catalogMatches = [
    ...Object.values(inventory.byProject).flat(),
    ...(inventory.global ?? []),
  ]
    .filter((session) => session.id === sessionId && !session.archived)
    .flatMap((session): InventorySessionTarget[] => {
      const backing = workspaceBacking({ workspaceId: session.workspaceId, kind: session.environment?.kind })
      const directory = backing?.workspaceId ?? session.directory ?? session.workspaceId
      const harness = routeSessionHarness(session)
      return directory
        ? [{
            directory,
            title: session.title,
            sessionRef: sessionRefForWorkspaceSession({
              sessionId,
              directory,
              workspace: backing,
              ...(harness ? { harness } : {}),
            }),
          }]
        : []
    })
  const rawMatches = [...workspaceMatches, ...catalogMatches]
  if (rawMatches.some((item) => item.directory === "/workspace")) return undefined
  const matches = rawMatches
    .filter((item, index, all) =>
      item.directory !== "/workspace" &&
      all.findIndex((candidate) => candidate.directory === item.directory) === index
    )
  if (matches.length !== 1) return undefined
  return matches[0]
}


function resolvedSessionTarget(sessionId: string, target: ResolvedSessionTarget): InventorySessionTarget {
  return {
    directory: target.directory,
    title: target.title,
    sessionRef: target.sessionRef ?? sessionRefForWorkspaceSession({
      sessionId,
      directory: target.directory,
      workspace: workspaceBacking({
        workspaceId: target.workspaceId,
        kind: target.environment?.kind,
      }),
    }),
  }
}

function resolveCanonicalSessionRoute(sessionId: string, inventory: RouteIntentInventory | undefined): SessionRouteResolution {
  const target = inventory ? sessionInventoryTarget(sessionId, inventory) : undefined
  if (target) return { state: "workspace", target }
  if (inventory?.loaded) return { state: "unresolved" }
  return { state: "resolving" }
}

export function createRouteIntentAdapter(input: {
  state: RouteIntentStateApi
  warmWorkspace?: (directory: string) => void
  inventory?: Accessor<RouteIntentInventory | undefined>
  resolveSession?: (sessionId: string) =>
    Promise<ResolvedSessionTarget | UnavailableSessionTarget | undefined> |
    ResolvedSessionTarget |
    UnavailableSessionTarget |
    undefined
  currentSessionId?: Accessor<string | undefined>
  canUseDocuments?: Accessor<boolean>
  navigate: (path: string, options?: { replace?: boolean }) => void
  log?: (event: string, payload?: Record<string, unknown>) => void
}) {
  const { state } = input
  const log = input.log ?? (() => undefined)
  const suppressedByFastSessionSwitch = (intent: RouteIntent) => {
    if (typeof window === "undefined" || !intent.sessionId) return false
    const fastSwitch = (
      window as typeof window & {
        __claxedoFastSessionSwitch?: { sessionId: string; until: number }
      }
    ).__claxedoFastSessionSwitch
    if (!fastSwitch || Date.now() > fastSwitch.until) return false
    return intent.sessionId !== fastSwitch.sessionId
  }

  const redirect = (path: string) => queueMicrotask(() => input.navigate(path, { replace: true }))

  // Activate a content. Preference order:
  //   1. If the content has a pane displaying it, focus that pane.
  //      (`wb.navigation.show` does this automatically — it routes the
  //      content into the focused pane when the content isn't visible,
  //      and focuses the pane displaying it when it is.)
  const activate = (contentId: string) => {
    state.wb.navigation.show(contentId)
  }

  const focusedContentId = (): string | null => state.wb.selectors.focusedContent()
  const matchesWorkspaceRoute = (content: ContentMeta, workspaceRouteId?: string) =>
    !workspaceRouteId || content.content?.workspaceRouteId === workspaceRouteId

  const findContent = (predicate: (m: ContentMeta) => boolean): ContentMeta | undefined => state.meta.find(predicate)

  const contentText = (content: ContentMeta, key: "directory" | "sessionId") => {
    const value = content.content?.[key]
    return typeof value === "string" && value.trim() ? value : undefined
  }

  const contentDirectory = (content: ContentMeta) => content.directory ?? contentText(content, "directory")
  const contentSessionId = (content: ContentMeta) => content.sessionId ?? contentText(content, "sessionId")
  const contentSessionRef = (content: ContentMeta) =>
    content.content?.type === "session" ? content.content.sessionRef : undefined
  const contentMatchesSessionRoute = (content: ContentMeta, sessionId: string) =>
    content.type === "session" &&
    contentSessionRef(content)?.sessionId === sessionId
  const existingSessionRouteContent = (sessionId: string) =>
    findContent((m) => contentMatchesSessionRoute(m, sessionId))
  const inventorySessionTarget = (sessionId: string) => {
    const inventory = input.inventory?.()
    if (!inventory) return undefined
    return sessionInventoryTarget(sessionId, inventory)
  }
  const openWorkspaceSession = (target: InventorySessionTarget, sessionId: string, title: string, decision: string) => {
    warmWorkspace(target.directory)
    const nextId = state.layout.openSession(target.directory, sessionId, target.title || title || "Session", {
      sessionRef: target.sessionRef,
    })
    if (focusedContentId() !== nextId) activate(nextId)
    log(decision, {
      sessionId,
      directory: target.directory,
      contentId: nextId,
      focusedContentId: focusedContentId(),
    })
  }
  const pendingSessionResolution = new Set<string>()
  const tryResolveSession = (sessionId: string, title: string) => {
    if (!input.resolveSession) return false
    if (pendingSessionResolution.has(sessionId)) return true
    pendingSessionResolution.add(sessionId)
    void Promise.resolve(input.resolveSession(sessionId))
      .then((rawTarget) => {
        // A resolver can outlive the route that launched it. Closing or
        // archiving that session while metadata is in flight is authoritative;
        // a late result must not recreate the surface that was just removed.
        if (isRouteIntentClosed({ sessionId })) return
        if (input.currentSessionId?.() && input.currentSessionId() !== sessionId) return
        if (rawTarget && "unavailable" in rawTarget) {
          markRouteIntentClosed({ sessionId })
          if (rawTarget.redirect) redirect(rawTarget.redirect)
          log("route intent unavailable session decision", {
            sessionId,
            redirect: rawTarget.redirect,
          })
          return
        }
        const target = rawTarget ? resolvedSessionTarget(sessionId, rawTarget) : undefined
        if (target) {
          openWorkspaceSession(target, sessionId, title, "route intent resolved session decision")
          return
        }
        const inventoryTarget = inventorySessionTarget(sessionId)
        if (inventoryTarget) {
          openWorkspaceSession(inventoryTarget, sessionId, title, "route intent resolved inventory fallback decision")
          return
        }
        if (!input.inventory?.()?.loaded) return
        const nextId = state.layout.openSessionById(sessionId, title || "Session")
        if (focusedContentId() !== nextId) activate(nextId)
        log("route intent unresolved session decision", {
          sessionId,
          contentId: nextId,
          focusedContentId: focusedContentId(),
        })
      })
      .finally(() => {
        pendingSessionResolution.delete(sessionId)
      })
    return true
  }
  const warmWorkspace = (directory: string) => {
    input.warmWorkspace?.(directory)
  }
  const isWorkspaceDraftSession = (content: ContentMeta, workspaceId: string, workspaceRouteId?: string) =>
    content.type === "session" &&
    contentDirectory(content) === workspaceId &&
    matchesWorkspaceRoute(content, workspaceRouteId) &&
    (contentSessionId(content) ?? "new") === "new"
  const workspaceRootSessionRef = (workspaceId: string, explicitBacking?: WorkspaceSessionBacking) =>
    sessionRefForWorkspaceSession({
      sessionId: "new",
      directory: workspaceId,
      workspace: explicitBacking ?? workspaceRootBacking(workspaceId, input.inventory?.()),
    })
  const upgradeWorkspaceDraftBacking = (
    content: ContentMeta,
    workspaceId: string,
    explicitBacking?: WorkspaceSessionBacking,
  ) => {
    if (content.content?.type !== "session") return
    const sessionRef = workspaceRootSessionRef(workspaceId, explicitBacking)
    if (!sessionRef) return
    if (contentSessionRef(content)?.toolSandbox?.kind === "workspace") return
    state.meta.patch(content.id, {
      content: {
        ...content.content,
        sessionRef,
      },
    })
  }
  const shouldWarmWorkspace = (intent: RouteIntent, workspaceId: string) => {
    if (intent.workspaceBrowse || intent.pageId || intent.terminalId || !intent.sessionId) return true
    const focusedId = focusedContentId()
    const focused = focusedId ? state.meta.get(focusedId) : undefined
    if (focused && contentDirectory(focused) === workspaceId) return false
    return !findContent((m) => contentDirectory(m) === workspaceId)
  }

  const receiveSession = (intent: RouteIntent) => {
    if (!intent.sessionId) return
    const existing = existingSessionRouteContent(intent.sessionId)
    if (existing?.id) {
      if (focusedContentId() !== existing.id) activate(existing.id)
      log("route intent existing session decision", {
        sessionId: intent.sessionId,
        contentId: existing.id,
        host: contentSessionRef(existing)?.host,
        focusedContentId: focusedContentId(),
      })
      return
    }
    if (tryResolveSession(intent.sessionId, intent.sessionTitle)) {
      log("route intent waiting for session resolver", {
        sessionId: intent.sessionId,
        focusedContentId: focusedContentId(),
      })
      return
    }
    const target = inventorySessionTarget(intent.sessionId)
    if (target) {
      openWorkspaceSession(target, intent.sessionId, intent.sessionTitle, "route intent inventory session decision")
      return
    }
    const resolution = resolveCanonicalSessionRoute(intent.sessionId, input.inventory?.())
    if (resolution.state === "resolving") {
      log("route intent waiting for session inventory", {
        sessionId: intent.sessionId,
        focusedContentId: focusedContentId(),
      })
      return
    }
    if (resolution.state === "workspace") {
      openWorkspaceSession(resolution.target, intent.sessionId, intent.sessionTitle, "route intent resolved workspace session decision")
      return
    }
    if (tryResolveSession(intent.sessionId, intent.sessionTitle)) return
    const nextId = state.layout.openSessionById(intent.sessionId, intent.sessionTitle || "Session")
    if (focusedContentId() !== nextId) activate(nextId)
    log("route intent unresolved session decision", {
      sessionId: intent.sessionId,
      contentId: nextId,
      focusedContentId: focusedContentId(),
    })
    return
  }

  const receiveTerminal = (intent: RouteIntent, workspaceId: string, terminalId: string) => {
    state.workspacePanel.close()
    if (terminalId.startsWith("pending-")) {
      const pending = findContent((m) => m.type === "terminal" && m.terminalId === terminalId)
      if (pending?.id) {
        if (focusedContentId() !== pending.id) activate(pending.id)
        return
      }
      if (intent.workspaceRouteId) {
        const focusedId = focusedContentId()
        const upgraded = focusedId
          ? findContent(
              (m) =>
                m.id === focusedId &&
                m.type === "terminal" &&
                !!m.terminalId &&
                !m.terminalId.startsWith("pending-") &&
                matchesWorkspaceRoute(m, intent.workspaceRouteId),
            )
          : undefined
        if (upgraded?.terminalId) {
          const target = workspaceTerminalRoute(intent.workspaceRouteId, upgraded.terminalId)
          // TerminalContent quietly history.replaceState's pending→real so the
          // live PTY socket is not torn down. Solid Router params can lag on
          // the pending id; a redirect here would remount the pane and drop
          // the stream before firstByte (cloud D blank xterm).
          if (typeof window !== "undefined" && window.location.pathname === target) {
            if (focusedContentId() !== upgraded.id) activate(upgraded.id)
            return
          }
          redirect(target)
          return
        }
        redirect(workspaceSessionRoute(intent.workspaceRouteId))
      }
      return
    }
    const existing =
      findContent((m) => {
        if (m.type !== "terminal") return false
        if (!matchesWorkspaceRoute(m, intent.workspaceRouteId)) return false
        return m.terminalId === terminalId
      }) ??
      (() => {
        // In-flight pending→real: route may already show pty_* while meta still
        // says pending-*. Only bind via ownership or a sole pending on this
        // placement — never the first of several concurrent creates, and never
        // any other terminal that merely shares the directory.
        const ownerContentId = state.terminal.owner(terminalId)
        if (ownerContentId) {
          return findContent(
            (m) =>
              m.id === ownerContentId && m.type === "terminal" && matchesWorkspaceRoute(m, intent.workspaceRouteId),
          )
        }
        const pendings = state.meta.findAll(
          (m) =>
            m.type === "terminal" &&
            !!m.terminalId?.startsWith("pending-") &&
            (intent.workspaceRouteId ? matchesWorkspaceRoute(m, intent.workspaceRouteId) : m.directory === workspaceId),
        )
        return pendings.length === 1 ? pendings[0] : undefined
      })()
    if (!existing?.id) {
      const nextId = state.layout.openTerminal(workspaceId, terminalId, "Terminal", {
        workspaceRouteId: intent.workspaceRouteId,
      })
      if (nextId && focusedContentId() !== nextId) activate(nextId)
      return
    }
    if (focusedContentId() !== existing.id) {
      activate(existing.id)
    }
    return
  }

  const receivePage = (intent: RouteIntent, workspaceId: string, pageId: string) => {
    if (pageId === ROUTE_INTENT_INDEX) {
      const existing = findContent(
        (m) =>
          m.type === "pages-index" && m.directory === workspaceId && matchesWorkspaceRoute(m, intent.workspaceRouteId),
      )
      const nextId =
        existing?.id ??
        state.layout.openPagesIndex(workspaceId, {
          workspaceRouteId: intent.workspaceRouteId,
        })
      if (nextId && focusedContentId() !== nextId) activate(nextId)
      return
    }
    if (input.canUseDocuments?.() !== true) {
      if (intent.workspaceRouteId) redirect(workspaceSessionRoute(intent.workspaceRouteId))
      return
    }
    const existing = findContent((m) => m.type === "page" && m.pageId === pageId)
    if (existing?.id && existing.sessionId) {
      state.meta.patch(existing.id, { sessionId: undefined })
    }
    const nextId = state.layout.openPage(pageId, "Untitled", workspaceId, undefined, {
      workspaceRouteId: intent.workspaceRouteId,
    })
    if (nextId && focusedContentId() !== nextId) activate(nextId)
    return
  }

  const receiveWorkspaceSession = (intent: RouteIntent, workspaceId: string) => {
    if (!intent.sessionId) {
      // Workspace session root (/w/:workspaceId/session). The URL is a directive to show a
      // new-session surface for this workspace. Without this, persisted canvas
      // state from another workspace can remain focused on first load.
      const focusedId = focusedContentId()
      const focused = focusedId ? state.meta.get(focusedId) : undefined
      if (focused && isWorkspaceDraftSession(focused, workspaceId, intent.workspaceRouteId)) {
        upgradeWorkspaceDraftBacking(focused, workspaceId, intent.workspaceBacking)
        return
      }

      const existing = findContent((m) => isWorkspaceDraftSession(m, workspaceId, intent.workspaceRouteId))
      if (existing?.id) {
        upgradeWorkspaceDraftBacking(existing, workspaceId, intent.workspaceBacking)
        activate(existing.id)
        return
      }

      sessionPerf.event("route.workspace-root-draft", {
        workspaceId,
        routeId: intent.workspaceRouteId ?? "",
        focused: focused ? `${focused.type}:${focused.sessionId ?? ""}:${focused.directory ?? ""}` : "",
      })
      state.layout.openSession(workspaceId, "new", "New Session", {
        sessionRef: workspaceRootSessionRef(workspaceId, intent.workspaceBacking),
        workspaceRouteId: intent.workspaceRouteId,
      })
      return
    }

    // Look up the focused content's meta to decide whether to preserve the
    // user's "context" view across the URL change.
    const focusedId = focusedContentId()
    const focused = focusedId ? state.meta.get(focusedId) : undefined
    const keepFocused =
      !!focused &&
      focused.type === "context" &&
      focused.directory === workspaceId &&
      matchesWorkspaceRoute(focused, intent.workspaceRouteId)

    const nextTitle = intent.sessionTitle || "Session"
    const existingSession = findContent(
      (content) =>
        contentMatchesSessionRoute(content, intent.sessionId!) &&
        contentDirectory(content) === workspaceId &&
        matchesWorkspaceRoute(content, intent.workspaceRouteId),
    )
    // Route navigation supplies workspace placement, not a new harness
    // selection. Preserve the identity established when this session started.
    const nextSessionRef = sessionRefForWorkspaceSession({
      sessionId: intent.sessionId,
      directory: workspaceId,
      workspace: intent.workspaceBacking,
      harness: existingSession?.content?.sessionRef?.harness,
    })
    if (
      intent.workspaceBacking &&
      existingSession?.content?.type === "session" &&
      !sameSessionRef(existingSession.content.sessionRef, nextSessionRef)
    ) {
      state.meta.patch(existingSession.id, {
        content: {
          ...existingSession.content,
          sessionRef: nextSessionRef,
        },
      })
    }

    // Open or reuse the session content. openSession does NOT focus it when
    // we want to keep the context content active.
    const nextId = state.layout.openSession(workspaceId, intent.sessionId, nextTitle, {
      focus: !keepFocused,
      sessionRef: nextSessionRef,
      workspaceRouteId: intent.workspaceRouteId,
    })

    log("route intent decision", {
      workspaceId,
      sessionId: intent.sessionId,
      nextTitle,
      contentId: nextId,
      keepFocused,
      focusedId,
      focusedType: focused?.type,
    })

    if (keepFocused && focused && focusedContentId() !== focused.id) {
      activate(focused.id)
    }
  }

  const receive = (intent: RouteIntent) => {
    if (!intent.ready) return
    if (suppressedByFastSessionSwitch(intent)) return
    if (intent.marketplace) {
      state.layout.openMarketplace()
      return
    }
    if (intent.tasks) {
      state.layout.openTasks(intent.tasksPage)
      return
    }
    const workspaceId = intent.workspaceId
    if (isRouteIntentClosed({ workspaceId, sessionId: intent.sessionId })) return
    if (!workspaceId) return receiveSession(intent)

    if (shouldWarmWorkspace(intent, workspaceId)) warmWorkspace(workspaceId)
    log("route intent", {
      workspaceId,
      sessionId: intent.sessionId,
      pageId: intent.pageId,
      terminalId: intent.terminalId,
      workspaceBrowse: intent.workspaceBrowse,
      sessionBadge: intent.sessionBadge,
      focusedContentId: focusedContentId(),
    })

    if (intent.workspaceBrowse && !intent.sessionId && !intent.pageId && !intent.terminalId) {
      const focusedId = focusedContentId()
      const focused = focusedId ? state.meta.get(focusedId) : undefined
      if (
        focused &&
        (isWorkspaceDraftSession(focused, workspaceId, intent.workspaceRouteId) ||
          ((focused.type === "session" || focused.type === "context") &&
            contentDirectory(focused) === workspaceId &&
            matchesWorkspaceRoute(focused, intent.workspaceRouteId)))
      )
        return
      // A narrow review panel covers the composer, so workspace browsing opens
      // it automatically only when both surfaces can remain visible.
      if (isNarrowViewport()) return
      state.workspacePanel.open("review", { workspaceDir: workspaceId })
      return
    }

    if (intent.terminalId) return receiveTerminal(intent, workspaceId, intent.terminalId)

    if (intent.pageId) return receivePage(intent, workspaceId, intent.pageId)

    receiveWorkspaceSession(intent, workspaceId)
  }

  return {
    receive,
  }
}
