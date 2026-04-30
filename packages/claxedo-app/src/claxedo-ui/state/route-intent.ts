/**
 * Route intent adapter — URL → workbench state.
 *
 * The URL is the source of truth for "which workspace/session/page the user
 * asked for", nothing else. Switching between existing contents, opening
 * terminals, changing focus — none of that flows through here. The reverse
 * direction (canvas → URL) lives in ClaxedoLayout.tsx and uses surfaceRoute().
 *
 * ## Invariants
 *
 * I1. Deep-link to an existing session (dir, sessionId) focuses that content
 *     and does NOT create a duplicate.
 * I2. Deep-link to an unknown sessionId creates exactly ONE content keyed to
 *     that sessionId, never a phantom "new" content.
 * I3. Workspace root (/ws with no sessionId/pageId) never auto-creates a
 *     session content. The user must explicitly open one.
 * I4. Workspace root never changes activation of existing contents — it's a
 *     no-op on the canvas.
 * I5. Page deep-link resolves to a matching page-kind content:
 *       - __index__    → pages-index content
 *       - <pageId>     → page content with that id
 *     Existing entries are reused; new ones are created if absent.
 * I6. Workgraph route (__workgraph__) opens a workgraph content when the
 *     feature is enabled. When disabled, it redirects to the workspace
 *     session route (no content is created).
 * I7. Deep-link to a page with a stale sessionId on the existing content
 *     clears that sessionId during activation (the URL is authoritative).
 * I8. A focused "context" content for the same workspace is preserved when
 *     a session deep-link arrives — we activate the session content in state
 *     but keep the context content as the focused one so the user's
 *     in-flight context view isn't stolen by a background URL update.
 */
import type { Session } from "@opencode-ai/sdk/v2"
import type { Accessor } from "solid-js"
import { sessionRoute } from "./surface-route"
import type { ClaxedoStateApi } from "./provider"
import type { ContentMeta } from "./types"

type Badge = {
  additions: number
  deletions: number
}

export type RouteIntent = {
  ready: boolean
  workspaceId: string | undefined
  sessionId: string | undefined
  pageId: string | undefined
  terminalId: string | undefined
  sessionTitle: string
  sessionBadge: Badge | undefined
}

type SyncApi = {
  child: (directory: string) => [{ session: Session[] }, unknown]
}

type SdkApi = {
  url: string
  client: {
    session: {
      update: (input: { directory: string; sessionID: string; title: string }) => Promise<unknown>
    }
  }
}

const ROUTE_INTENT_INDEX = "__index__"
const ROUTE_INTENT_WORKGRAPH = "__workgraph__"

function isDefaultSessionTitle(value: string) {
  return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
}

export function createRouteIntentAdapter(input: {
  state: ClaxedoStateApi
  globalSync: SyncApi
  globalSDK: SdkApi
  workgraphEnabled?: Accessor<boolean>
  navigate: (path: string, options?: { replace?: boolean }) => void
  log?: (event: string, payload?: Record<string, unknown>) => void
}) {
  const { state } = input
  const attempted = new Set<string>()
  const log = input.log ?? (() => undefined)
  const workgraph = () => input.workgraphEnabled?.() ?? false

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

  const receive = (intent: RouteIntent) => {
    if (!intent.ready) return
    const workspaceId = intent.workspaceId
    if (!workspaceId) return

    input.globalSync.child(workspaceId)
    log("route intent", {
      workspaceId,
      sessionId: intent.sessionId,
      pageId: intent.pageId,
      terminalId: intent.terminalId,
      focusedContentId: focusedContentId(),
    })

    if (intent.terminalId) {
      const existing = findContent(
        (m) =>
          m.type === "terminal" &&
          m.directory === workspaceId &&
          m.terminalId === intent.terminalId,
      )
      // Don't auto-create a phantom terminal content from URL alone — terminals
      // are tied to live PTYs and synthesizing one here without a queued PTY
      // create would leave a dangling content. If the content doesn't exist,
      // treat the URL as a no-op and let the persisted/canvas state win.
      if (!existing?.id) return
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
      if (intent.pageId === ROUTE_INTENT_WORKGRAPH) {
        if (!workgraph()) {
          redirect(sessionRoute(workspaceId))
          return
        }
        const existing = findContent(
          (m) => m.type === "workgraph" && m.directory === workspaceId,
        )
        const nextId = existing?.id ?? state.layout.openWorkgraph(workspaceId)
        if (nextId && focusedContentId() !== nextId) activate(nextId)
        return
      }

      const existing = findContent(
        (m) =>
          m.type === "page" &&
          m.directory === workspaceId &&
          m.pageId === intent.pageId,
      )
      if (existing?.id && existing.sessionId) {
        state.meta.patch(existing.id, { sessionId: undefined })
      }
      const nextId =
        existing?.id ?? state.layout.openPage(intent.pageId, "Untitled", workspaceId)
      if (nextId && focusedContentId() !== nextId) activate(nextId)
      return
    }

    if (!intent.sessionId) {
      // Workspace root (/ws). URL is not a directive to create or activate
      // anything. Canvas stays as-is; sidebar actions drive session creation
      // explicitly.
      return
    }

    const key = `${workspaceId}:${intent.sessionId}`
    // Title is no longer stored on ContentMeta. The route-intent optimization
    // that auto-persists default-session titles has lost its source; session
    // titles update via upstream globalSync.session[i].title directly.
    const existingTitle: string | undefined = undefined
    const desired = existingTitle && !isDefaultSessionTitle(existingTitle) ? existingTitle : undefined
    const shouldPersist =
      isDefaultSessionTitle(intent.sessionTitle) && !!desired && !attempted.has(key)
    if (shouldPersist) {
      attempted.add(key)
      void input.globalSDK.client.session
        .update({ directory: workspaceId, sessionID: intent.sessionId, title: desired })
        .catch(() => undefined)
    }

    // Look up the focused content's meta to decide whether to preserve the
    // user's "context" view across the URL change.
    const focusedId = focusedContentId()
    const focused = focusedId ? state.meta.get(focusedId) : undefined
    const keepFocused =
      !!focused && focused.type === "context" && focused.directory === workspaceId

    const nextTitle =
      desired ||
      intent.sessionTitle ||
      existingTitle ||
      "Session"

    // Open or reuse the session content. openSession does NOT focus it when
    // we want to keep the context content active.
    const nextId = state.layout.openSession(
      workspaceId,
      intent.sessionId,
      nextTitle,
      { focus: !keepFocused },
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
