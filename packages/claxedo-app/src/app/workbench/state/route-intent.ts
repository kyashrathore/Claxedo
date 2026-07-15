/**
 * Route intent adapter — URL → workbench state.
 *
 * The URL is the source of truth for "which workspace/session/page the user
 * asked for", nothing else. Switching between existing contents, opening
 * terminals, changing focus — none of that flows through here. The reverse
 * direction (canvas → URL) lives in the app shell and uses surfaceRoute().
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
import { workspaceSessionRoute } from "@/platform/identity/route"
import { sessionRefForWorkspaceSession, type SessionRef, type WorkspaceSessionBacking } from "@/platform/identity/session-ref"
import type { ClaxedoStateApi } from "./provider"
import type { ContentMeta } from "./types"
import { routeSessionHarness } from "./route-session-harness"
import { isNarrowViewport } from "../workbench/index"

type Badge = {
  additions: number
  deletions: number
}

export type RouteIntent = {
  ready: boolean
  marketplace: boolean
  workgraph?: boolean
  workspaceId: string | undefined
  sessionId: string | undefined
  pageId: string | undefined
  terminalId: string | undefined
  workspaceBrowse: boolean
  sessionTitle: string
  sessionBadge: Badge | undefined
}

export type RouteIntentInventory = {
  global?: Array<{ id?: string; workspaceId?: string; directory?: string; title?: string; environment?: { kind?: string }; harness?: unknown; runner?: unknown; config?: unknown; harnessType?: unknown }>
  byWorkspace: Record<string, { key?: string; workspaceId?: string; directory?: string; sessions?: Array<{ id?: string; title?: string; environment?: { kind?: string }; harness?: unknown; runner?: unknown; config?: unknown; harnessType?: unknown }> }>
  byProject: Record<string, Array<{ id?: string; workspaceId?: string; directory?: string; title?: string; environment?: { kind?: string }; harness?: unknown; runner?: unknown; config?: unknown; harnessType?: unknown }>>
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
type SessionRouteResolution =
  | { state: "resolving" }
  | { state: "workspace"; target: InventorySessionTarget }
  | { state: "central" }

export type RouteIntentStateApi = Pick<ClaxedoStateApi, "wb" | "meta" | "layout" | "workspacePanel">

const CLOSED_ROUTE_TTL_MS = 10_000
/**
 * Hard backstop on retained close markers. Entries self-expire after
 * CLOSED_ROUTE_TTL_MS and are swept on every write, so the map is normally
 * bounded by how many routes close within a 10s window; this cap only guards a
 * pathological burst. Without any sweep, a route closed and never revisited
 * lingered forever (its key is only pruned when that exact key is re-checked),
 * a slow leak in a long-running Electron shell.
 */
export const CLOSED_ROUTE_MAX = 256
const closedRouteKeys = new Map<string, number>()

function closedRouteKey(input: { workspaceId?: string; sessionId?: string }) {
  return `${input.workspaceId ?? ""}\0${input.sessionId ?? ""}`
}

function sweepClosedRoutes(now: number) {
  for (const [key, until] of closedRouteKeys) {
    if (now > until) closedRouteKeys.delete(key)
  }
  while (closedRouteKeys.size > CLOSED_ROUTE_MAX) {
    const oldest = closedRouteKeys.keys().next().value
    if (oldest === undefined) break
    closedRouteKeys.delete(oldest)
  }
}

export function markRouteIntentClosed(input: { workspaceId?: string; sessionId?: string }) {
  const now = Date.now()
  closedRouteKeys.set(closedRouteKey(input), now + CLOSED_ROUTE_TTL_MS)
  sweepClosedRoutes(now)
}

/** Test-only: current retained close-marker count (asserts the bound). */
export function routeIntentClosedSizeForTest() {
  return closedRouteKeys.size
}

export function isRouteIntentClosed(input: { workspaceId?: string; sessionId?: string }) {
  return consumeRouteIntentClosed(input)
}

export function resetRouteIntentClosedForTest() {
  closedRouteKeys.clear()
}

function consumeRouteIntentClosed(input: { workspaceId?: string; sessionId?: string }) {
  const key = closedRouteKey(input)
  const until = closedRouteKeys.get(key)
  if (!until) return false
  if (Date.now() > until) {
    closedRouteKeys.delete(key)
    return false
  }
  return true
}

function workspaceBacking(input: { workspaceId?: string; kind?: string }): WorkspaceSessionBacking | undefined {
  if (!input.workspaceId || (input.kind !== "cloud" && input.kind !== "user-hosted")) return
  return {
    workspaceId: input.workspaceId,
    kind: input.kind,
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
    .filter(([, group]) => group.sessions?.some((session) => session.id === sessionId))
    .map(([key, group]): InventorySessionTarget => {
      const session = group.sessions?.find((session) => session.id === sessionId)
      const directory =
        group.workspaceId ??
        (group.key && group.key !== "/workspace" ? group.key : undefined) ??
        (group.directory && group.directory !== "/workspace" ? group.directory : undefined) ??
        key
      const harness = routeSessionHarness(session)
      return {
        directory,
        title: session?.title,
        sessionRef: sessionRefForWorkspaceSession({
          sessionId,
          directory,
          workspace: workspaceBacking({
            workspaceId: group.workspaceId,
            kind: session?.environment?.kind,
          }),
          ...(harness ? { harness } : {}),
        }),
      }
    })
  const projectMatches = Object.values(inventory.byProject)
    .flatMap((sessions) => sessions)
    .filter((session) => session.id === sessionId)
    .flatMap((session): InventorySessionTarget[] => {
      const directory = session.workspaceId ?? session.directory
      const harness = routeSessionHarness(session)
      return directory
        ? [{
            directory,
            title: session.title,
            sessionRef: sessionRefForWorkspaceSession({
              sessionId,
              directory,
            workspace: workspaceBacking({
                workspaceId: session.workspaceId,
                kind: session.environment?.kind,
              }),
              ...(harness ? { harness } : {}),
            }),
          }]
        : []
    })
  const globalMatches = (inventory.global ?? [])
    .filter((session) => session.id === sessionId)
    .flatMap((session): InventorySessionTarget[] => {
      const directory = session.workspaceId ?? session.directory
      const harness = routeSessionHarness(session)
      return directory
        ? [{
            directory,
            title: session.title,
            sessionRef: sessionRefForWorkspaceSession({
              sessionId,
              directory,
            workspace: workspaceBacking({
                workspaceId: session.workspaceId,
                kind: session.environment?.kind,
              }),
              ...(harness ? { harness } : {}),
            }),
          }]
        : []
    })
  const rawMatches = [...workspaceMatches, ...projectMatches, ...globalMatches]
  if (rawMatches.some((item) => item.directory === "/workspace")) return
  const matches = rawMatches
    .filter((item, index, all) =>
      item.directory !== "/workspace" &&
      all.findIndex((candidate) => candidate.directory === item.directory) === index
    )
  if (matches.length !== 1) return
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
  if (inventory?.loaded) return { state: "central" }
  return { state: "resolving" }
}

export function createRouteIntentAdapter(input: {
  state: RouteIntentStateApi
  warmWorkspace?: (directory: string) => void
  inventory?: Accessor<RouteIntentInventory | undefined>
  resolveSession?: (sessionId: string) => Promise<ResolvedSessionTarget | undefined> | ResolvedSessionTarget | undefined
  currentSessionId?: Accessor<string | undefined>
  canUsePages?: Accessor<boolean>
  navigate: (path: string, options?: { replace?: boolean }) => void
  log?: (event: string, payload?: Record<string, unknown>) => void
}) {
  const { state } = input
  const log = input.log ?? (() => undefined)
  const suppressedByFastSessionSwitch = (intent: RouteIntent) => {
    if (typeof window === "undefined" || !intent.sessionId) return false
    const fastSwitch = (window as typeof window & {
      __claxedoFastSessionSwitch?: { sessionId: string; until: number }
    }).__claxedoFastSessionSwitch
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

  const findContent = (predicate: (m: ContentMeta) => boolean): ContentMeta | undefined =>
    state.meta.find(predicate)

  const contentText = (content: ContentMeta, key: "directory" | "sessionId") => {
    const value = content.content?.[key]
    return typeof value === "string" && value.trim() ? value : undefined
  }

  const contentDirectory = (content: ContentMeta) => content.directory ?? contentText(content, "directory")
  const contentSessionId = (content: ContentMeta) => content.sessionId ?? contentText(content, "sessionId")
  const contentSessionRef = (content: ContentMeta) => content.content?.type === "session" ? content.content.sessionRef : undefined
  const contentMatchesSessionRoute = (content: ContentMeta, sessionId: string) =>
    content.type === "session" &&
    contentSessionRef(content)?.sessionId === sessionId
  const existingSessionRouteContent = (sessionId: string, host: "workspace" | "central") =>
    findContent((m) => contentMatchesSessionRoute(m, sessionId) && contentSessionRef(m)?.host === host)
  const inventorySessionTarget = (sessionId: string) => {
    const inventory = input.inventory?.()
    if (!inventory) return
    return sessionInventoryTarget(sessionId, inventory)
  }
  const pendingSessionResolution = new Set<string>()
  const tryResolveSession = (sessionId: string, title: string) => {
    if (!input.resolveSession) return false
    if (pendingSessionResolution.has(sessionId)) return true
    pendingSessionResolution.add(sessionId)
    void Promise.resolve(input.resolveSession(sessionId))
      .then((rawTarget) => {
        if (input.currentSessionId?.() && input.currentSessionId() !== sessionId) return
        const target = rawTarget ? resolvedSessionTarget(sessionId, rawTarget) : undefined
        if (target) {
          warmWorkspace(target.directory)
          const nextId = state.layout.openSession(
            target.directory,
            sessionId,
            target.title || title || "Session",
            { sessionRef: target.sessionRef },
          )
          if (focusedContentId() !== nextId) activate(nextId)
          log("route intent resolved session decision", {
            sessionId,
            directory: target.directory,
            contentId: nextId,
            focusedContentId: focusedContentId(),
          })
          return
        }
        const inventoryTarget = inventorySessionTarget(sessionId)
        if (inventoryTarget) {
          warmWorkspace(inventoryTarget.directory)
          const nextId = state.layout.openSession(
            inventoryTarget.directory,
            sessionId,
            inventoryTarget.title || title || "Session",
            { sessionRef: inventoryTarget.sessionRef },
          )
          if (focusedContentId() !== nextId) activate(nextId)
          log("route intent resolved inventory fallback decision", {
            sessionId,
            directory: inventoryTarget.directory,
            contentId: nextId,
            focusedContentId: focusedContentId(),
          })
          return
        }
        if (!input.inventory?.()?.loaded) return
        const nextId = state.layout.openCentralSession(sessionId, title || "Session")
        if (focusedContentId() !== nextId) activate(nextId)
        log("route intent resolved central decision", {
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
  const isWorkspaceDraftSession = (content: ContentMeta, workspaceId: string) =>
    content.type === "session" &&
    contentDirectory(content) === workspaceId &&
    (contentSessionId(content) ?? "new") === "new"
  const workspaceRootSessionRef = (workspaceId: string) =>
    sessionRefForWorkspaceSession({
      sessionId: "new",
      directory: workspaceId,
      workspace: workspaceRootBacking(workspaceId, input.inventory?.()),
    })
  const upgradeWorkspaceDraftBacking = (content: ContentMeta, workspaceId: string) => {
    if (content.content?.type !== "session") return
    const sessionRef = workspaceRootSessionRef(workspaceId)
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

  const receive = (intent: RouteIntent) => {
    if (!intent.ready) return
    if (suppressedByFastSessionSwitch(intent)) return
    if (intent.marketplace) {
      state.layout.openMarketplace()
      return
    }
    if (intent.workgraph) {
      state.layout.openWorkGraph()
      return
    }
    const workspaceId = intent.workspaceId
    if (consumeRouteIntentClosed({ workspaceId, sessionId: intent.sessionId })) return
    if (!workspaceId) {
      if (!intent.sessionId) return
      const existing = existingSessionRouteContent(intent.sessionId, "workspace")
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
        warmWorkspace(target.directory)
        const nextId = state.layout.openSession(
          target.directory,
          intent.sessionId,
          target.title || intent.sessionTitle || "Session",
          { sessionRef: target.sessionRef },
        )
        if (focusedContentId() !== nextId) activate(nextId)
        log("route intent inventory session decision", {
          sessionId: intent.sessionId,
          directory: target.directory,
          contentId: nextId,
          focusedContentId: focusedContentId(),
        })
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
        warmWorkspace(resolution.target.directory)
        const nextId = state.layout.openSession(
          resolution.target.directory,
          intent.sessionId,
          resolution.target.title || intent.sessionTitle || "Session",
          { sessionRef: resolution.target.sessionRef },
        )
        if (focusedContentId() !== nextId) activate(nextId)
        log("route intent resolved workspace session decision", {
          sessionId: intent.sessionId,
          directory: resolution.target.directory,
          contentId: nextId,
          focusedContentId: focusedContentId(),
        })
        return
      }
      if (tryResolveSession(intent.sessionId, intent.sessionTitle)) return
      const central = existingSessionRouteContent(intent.sessionId, "central")
      if (central?.id) {
        if (focusedContentId() !== central.id) activate(central.id)
        log("route intent existing central session decision", {
          sessionId: intent.sessionId,
          contentId: central.id,
          focusedContentId: focusedContentId(),
        })
        return
      }
      const nextId = state.layout.openCentralSession(intent.sessionId, intent.sessionTitle || "Session")
      if (focusedContentId() !== nextId) activate(nextId)
      log("route intent central decision", {
        sessionId: intent.sessionId,
        contentId: nextId,
        focusedContentId: focusedContentId(),
      })
      return
    }

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
        (
          isWorkspaceDraftSession(focused, workspaceId) ||
          ((focused.type === "session" || focused.type === "context") && contentDirectory(focused) === workspaceId)
        )
      ) return
      // At narrow (collapsed) width the review panel forces full-width
      // (`workspace-panel.tsx` `isMobile()`), so this unconditional auto-open
      // would cover the entire phone screen — composer included — with no user
      // action. Suppress it there; the draft composer is the boot surface. The
      // desktop side-by-side rationale for the auto-open does not exist at phone
      // width, and desktop behavior is byte-for-byte unchanged. (WP-C3 §3.2)
      if (isNarrowViewport()) return
      state.workspacePanel.open("review", { workspaceDir: workspaceId })
      return
    }

    if (intent.terminalId) {
      state.workspacePanel.close()
      if (intent.terminalId.startsWith("pending-")) {
        const pending = findContent(
          (m) => m.type === "terminal" && m.terminalId === intent.terminalId,
        )
        if (pending?.id) {
          if (focusedContentId() !== pending.id) activate(pending.id)
          return
        }
        redirect(workspaceSessionRoute(workspaceId))
        return
      }
      const existing = findContent(
        (m) =>
          m.type === "terminal" &&
          m.directory === workspaceId &&
          m.terminalId === intent.terminalId,
      )
      if (!existing?.id) {
        const nextId = state.layout.openTerminal(workspaceId, intent.terminalId, "Terminal")
        if (nextId && focusedContentId() !== nextId) activate(nextId)
        return
      }
      if (focusedContentId() !== existing.id) {
        activate(existing.id)
      }
      return
    }

    if (intent.pageId) {
      if (intent.pageId === ROUTE_INTENT_INDEX) {
        const existing = findContent(
          (m) => m.type === "pages-index" && m.directory === workspaceId,
        )
        const nextId = existing?.id ?? state.layout.openPagesIndex(workspaceId)
        if (nextId && focusedContentId() !== nextId) activate(nextId)
        return
      }
      if (input.canUsePages?.() !== true) {
        redirect(workspaceSessionRoute(workspaceId))
        return
      }
      const existing = findContent((m) => m.type === "page" && m.pageId === intent.pageId)
      if (existing?.id && existing.sessionId) {
        state.meta.patch(existing.id, { sessionId: undefined })
      }
      const nextId = state.layout.openPage(intent.pageId, "Untitled", workspaceId)
      if (nextId && focusedContentId() !== nextId) activate(nextId)
      return
    }

    if (!intent.sessionId) {
      // Workspace session root (/w/:workspaceId/session). The URL is a directive to show a
      // new-session surface for this workspace. Without this, persisted canvas
      // state from another workspace can remain focused on first load.
      const focusedId = focusedContentId()
      const focused = focusedId ? state.meta.get(focusedId) : undefined
      if (focused && isWorkspaceDraftSession(focused, workspaceId)) {
        upgradeWorkspaceDraftBacking(focused, workspaceId)
        return
      }

      const existing = findContent((m) => isWorkspaceDraftSession(m, workspaceId))
      if (existing?.id) {
        upgradeWorkspaceDraftBacking(existing, workspaceId)
        activate(existing.id)
        return
      }

      state.layout.openSession(workspaceId, "new", "New Session", {
        sessionRef: workspaceRootSessionRef(workspaceId),
      })
      return
    }

    // Look up the focused content's meta to decide whether to preserve the
    // user's "context" view across the URL change.
    const focusedId = focusedContentId()
    const focused = focusedId ? state.meta.get(focusedId) : undefined
    const keepFocused =
      !!focused && focused.type === "context" && focused.directory === workspaceId

    const nextTitle = intent.sessionTitle || "Session"

    // Open or reuse the session content. openSession does NOT focus it when
    // we want to keep the context content active.
    const nextId = state.layout.openSession(
      workspaceId,
      intent.sessionId,
      nextTitle,
      {
        focus: !keepFocused,
        sessionRef: sessionRefForWorkspaceSession({
          sessionId: intent.sessionId,
          directory: workspaceId,
        }),
      },
    )

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

  return {
    receive,
  }
}
