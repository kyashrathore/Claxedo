// Orchestration — `state.layout.openX` / `closeContent` / `closePane` etc.
//
// These are the high-level "user did a thing" actions that cross slice
// boundaries. Each action:
//   1. Looks up an existing meta entry by the content identity.
//   2. If present, focuses it via `wb.navigation.show`.
//   3. Otherwise creates a new meta entry, calls `wb.contents.add`, then shows.
//
// One content is one tab: each `contentId` is the same id the Workbench uses
// and lives in `state.meta`.

import type { ContentMeta, ContentPayload, ContentType } from "./types"
import { PINNED_CONTENT_TYPES } from "./types"
import { selectEvictableSurfaces } from "./surface-budget"
import type { Edge, UseWorkbench } from "../workbench/index"
import type { MetadataSliceApi } from "./metadata"
import type { TerminalSliceApi } from "./terminal"
import {
  centralSessionRef,
  hasBacking,
  isLocalSessionDirectory,
  localSessionRefForDirectory,
  type SessionRef,
} from "@/platform/identity/session-ref"
import { markRouteIntentClosed } from "./route-intent"

type WorkspaceDirectoryRef = string

export type ContentCloseReason = "user" | "panic" | "merge" | "evict"

export type CleanupHook = (id: string, meta: ContentMeta | undefined, reason: ContentCloseReason) => void
export type OpenSessionOptions = { focus?: boolean; sessionRef?: SessionRef }

export type LayoutOrchestrationApi = {
  openSession(directory: string, sessionId: string, title?: string, opts?: OpenSessionOptions): string
  openCentralSession(sessionId: string, title?: string, opts?: { focus?: boolean }): string
  openDraftSession(providerDirectory: string, draftId: string, opts?: { focus?: boolean }): string
  completeDraftSession(input: { draftId: string; directory: string; sessionId: string; title?: string; sessionRef?: SessionRef }): string | undefined
  openTerminal(directory: string, terminalId: string, title?: string, opts?: { focus?: boolean; command?: string }): string
  openPage(pageId: string, title?: string, directory?: string, filePath?: string): string
  openPagesIndex(directory?: string): string
  openMarketplace(): string
  openWorkGraph(): string
  openWorkspaceWorkGraph(directory: WorkspaceDirectoryRef): string
  openTaskComposer(directory?: WorkspaceDirectoryRef): string
  /**
   * Close a content fully — drop the meta entry, remove from workbench, run
   * cleanup hooks (e.g. terminal owner/lifecycle teardown).
   */
  closeContent(id: string, reason?: ContentCloseReason): void
  closePane(paneId: string, opts?: { destroyContent?: boolean }): void
  moveContent(id: string, fromPane: string, toPane: string | "new"): void
  splitContent(targetPane: string, edge: Edge, id: string): void
  /** Alias for `wb.navigation.show(id)`. */
  showContent(id: string): void
  restoreContentFocus(id: string): void

  /**
   * Internal hook the rail-layout's `onContentClose` calls when the Workbench
   * removes a content (drag-drop merge or split-close with destroyContent).
   * Cleans up meta + per-type state without touching the workbench.
   */
  _cleanupOnClose(id: string, reason: ContentCloseReason): void
}

const PINNED_TYPES = PINNED_CONTENT_TYPES

const newId = (type: ContentType) => {
  const prefix =
    type === "marketplace"
      ? "mkt"
      : type === "workgraph" || type === "workspace-workgraph"
        ? "wg"
        : type === "task-composer"
          ? "task"
          : type
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function sameSessionRef(a: SessionRef | undefined, b: SessionRef | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (
    a.sessionId !== b.sessionId ||
    a.host !== b.host ||
    a.workspaceId !== b.workspaceId ||
    a.cwd !== b.cwd ||
    a.toolSandbox?.kind !== b.toolSandbox?.kind
  ) return false
  if (a.toolSandbox?.kind === "workspace" && b.toolSandbox?.kind === "workspace") {
    return (
      a.toolSandbox.workspaceId === b.toolSandbox.workspaceId &&
      a.toolSandbox.hosting === b.toolSandbox.hosting &&
      a.toolSandbox.hostId === b.toolSandbox.hostId
    )
  }
  if (a.toolSandbox?.kind === "local" && b.toolSandbox?.kind === "local") {
    return a.toolSandbox.cwd === b.toolSandbox.cwd
  }
  return true
}

export function createLayoutOrchestration(input: {
  wb: UseWorkbench
  meta: MetadataSliceApi
  terminal: TerminalSliceApi
  /** Called per-type after the Workbench removes content. */
  cleanupHook?: CleanupHook
}): LayoutOrchestrationApi {
  const { wb, meta, terminal, cleanupHook } = input

  const restoreContentFocus = (id: string) => {
    const origin = meta.get(id)?.returnFocus
    if (!origin || typeof document === "undefined") return
    const attempt = (remaining: number) => {
      const exact = origin.originId
        ? document.querySelector<HTMLElement>(`[data-subagent-origin-id="${CSS.escape(origin.originId)}"]`)
        : undefined
      const marker = origin.subagentKey
        ? document.querySelector<HTMLElement>(
            `[data-session-timeline-session-id="${CSS.escape(origin.parentSessionId)}"] [data-subagent-key="${CSS.escape(origin.subagentKey)}"]`,
          )
        : document.querySelector<HTMLElement>(`[data-session-timeline-session-id="${CSS.escape(origin.parentSessionId)}"]`)
      const target = exact ?? marker?.closest<HTMLElement>("a, button") ?? marker
      if (target && target.getClientRects().length > 0) {
        target.focus()
        target.scrollIntoView({ block: "center" })
        return
      }
      if (remaining > 0) requestAnimationFrame(() => attempt(remaining - 1))
    }
    queueMicrotask(() => attempt(60))
  }

  const showOrCreate = (
    existing: ContentMeta | undefined,
    build: () => { meta: ContentMeta; payload: ContentPayload | undefined },
    opts?: { focus?: boolean },
  ): string => {
    if (existing) {
      if (opts?.focus !== false) wb.navigation.show(existing.id)
      return existing.id
    }
    const { meta: nextMeta, payload } = build()
    if (payload) nextMeta.content = payload
    meta.upsert(nextMeta)
    addContent(nextMeta.id)
    if (opts?.focus !== false) wb.navigation.show(nextMeta.id)
    return nextMeta.id
  }

  const patchSessionTitle = (
    existing: ContentMeta,
    directory: string | undefined,
    sessionId: string,
    title?: string,
    explicitSessionRef?: SessionRef,
  ) => {
    const nextTitle = title ?? existing.content?.title
    const sessionRef = explicitSessionRef ?? existing.content?.sessionRef
    if (
      existing.directory === directory &&
      existing.sessionId === sessionId &&
      existing.content?.title === nextTitle &&
      sameSessionRef(existing.content?.sessionRef, sessionRef)
    ) return

    meta.patch(existing.id, {
      ...(directory ? { directory } : {}),
      sessionId,
      content: {
        ...existing.content,
        type: "session",
        ...(directory ? { directory } : {}),
        sessionId,
        ...(nextTitle ? { title: nextTitle } : {}),
        ...(sessionRef ? { sessionRef } : {}),
      },
    })
  }

  const patchTerminalTitle = (existing: ContentMeta, directory: string, terminalId: string, title?: string) => {
    if (!title || existing.content?.title === title) return
    meta.patch(existing.id, {
      content: {
        ...existing.content,
        type: "terminal",
        directory,
        terminalId,
        title,
      },
    })
  }

  const sameWorkspaceSession = (
    m: ContentMeta,
    directory: string,
    sessionId: string,
    sessionRef: SessionRef | undefined,
  ) => {
    if (m.type !== "session" || !m.directory || m.sessionId !== sessionId) return false
    if (sessionId === "new") return m.directory === directory
    if (m.directory === directory) return true
    return !!sessionRef && !!m.content?.sessionRef && sameSessionRef(m.content.sessionRef, sessionRef)
  }

  const _cleanupOnClose: LayoutOrchestrationApi["_cleanupOnClose"] = (id, reason) => {
    const m = meta.get(id)
    if (!m) return
    // Per-type cleanup
    if (m.type === "terminal" && m.terminalId) {
      terminal.clearForContent(id)
    }
    cleanupHook?.(id, m, reason)
    restoreContentFocus(id)
    meta.remove(id)
  }

  /**
   * Add a content to the workbench and bring the open-surface count back within
   * budget. Every `openX` funnels through here, so the LRU cap holds regardless
   * of which surface type crossed the line — and regardless of whether the new
   * tab took focus, since `contents.add` already lands it at the head of
   * `contentRecency` and it is therefore never its own eviction victim.
   */
  const addContent = (id: string) => {
    wb.contents.add(id)

    const state = wb.state
    const evictable = selectEvictableSurfaces({
      contentIds: state.contentIds,
      contentRecency: state.contentRecency,
      mountedIds: state.panes
        .map((pane) => pane.contentId)
        .filter((contentId): contentId is string => !!contentId),
      pinnedIds: state.contentIds.filter((contentId) => {
        const m = meta.get(contentId)
        return !!m && PINNED_TYPES.has(m.type)
      }),
    })

    for (const evicted of evictable) {
      // Deliberately not `closeContent`: eviction is not user intent, so it must
      // not record a route-intent close (that would stop the route layer from
      // ever re-materializing the session the user navigates back to).
      wb.contents.remove(evicted)
      _cleanupOnClose(evicted, "evict")
    }
  }

  return {
    openSession(directory, sessionId, title, opts) {
      const existing = meta.find(
        (m) => sameWorkspaceSession(m, directory, sessionId, opts?.sessionRef),
      )
      if (existing) {
        patchSessionTitle(
          existing,
          directory,
          sessionId,
          title,
          opts?.sessionRef,
        )
      }
      const contentId = showOrCreate(
        existing,
        () => {
          const id = newId("session")
          const sessionRef = opts?.sessionRef
          return {
            meta: {
              id,
              type: "session",
              scope: "directory",
              directory,
              sessionId,
            },
            payload: {
              type: "session",
              directory,
              sessionId,
              title,
              ...(sessionRef ? { sessionRef } : {}),
            },
          }
        },
        opts,
      )
      for (const duplicate of meta.findAll((m) =>
        m.id !== contentId && (
          sameWorkspaceSession(m, directory, sessionId, opts?.sessionRef) ||
          (
            sessionId !== "new" &&
            m.type === "session" &&
            !m.directory &&
            m.sessionId === sessionId
          )
        )
      )) {
        wb.contents.remove(duplicate.id)
        _cleanupOnClose(duplicate.id, "merge")
      }
      return contentId
    },

    openCentralSession(sessionId, title, opts) {
      const workspaceExisting = meta.find(
        (m) =>
          m.type === "session" &&
          !!m.directory &&
          m.sessionId === sessionId &&
          (
            m.content?.type === "session" &&
            m.content.sessionRef?.host === "workspace" &&
            hasBacking(m.content.sessionRef) ||
            isLocalSessionDirectory(m.directory)
          ),
      )
      if (workspaceExisting) {
        if (workspaceExisting.directory && workspaceExisting.content?.type === "session" && !workspaceExisting.content.sessionRef) {
          const sessionRef = localSessionRefForDirectory({ sessionId, directory: workspaceExisting.directory })
          meta.patch(workspaceExisting.id, {
            content: {
              ...workspaceExisting.content,
              ...(sessionRef ? { sessionRef } : {}),
            },
          })
        }
        if (opts?.focus !== false) wb.navigation.show(workspaceExisting.id)
        return workspaceExisting.id
      }
      const existing = meta.find(
        (m) => m.type === "session" && !m.directory && m.sessionId === sessionId,
      )
      if (existing) patchSessionTitle(existing, undefined, sessionId, title)
      const contentId = showOrCreate(
        existing,
        () => {
          const id = newId("session")
          return {
            meta: {
              id,
              type: "session",
              scope: "global",
              sessionId,
            },
            payload: {
              type: "session",
              sessionId,
              title,
              sessionRef: centralSessionRef({ sessionId }),
            },
          }
        },
        opts,
      )
      for (const duplicate of meta.findAll((m) =>
        m.type === "session" && m.sessionId === sessionId && m.id !== contentId
      )) {
        wb.contents.remove(duplicate.id)
        _cleanupOnClose(duplicate.id, "merge")
      }
      return contentId
    },

    openDraftSession(providerDirectory, draftId, opts) {
      const existing = meta.find(
        (m) => m.type === "draft-session" && m.providerDirectory === providerDirectory && m.draftId === draftId,
      )
      return showOrCreate(
        existing,
        () => {
          const id = newId("draft-session")
          return {
            meta: {
              id,
              type: "draft-session",
              scope: "global",
              providerDirectory,
              draftId,
            },
            payload: {
              type: "draft-session",
              draftId,
              providerDirectory,
            },
          }
        },
        opts,
      )
    },

    completeDraftSession(input) {
      const draft = meta.find((m) => m.type === "draft-session" && m.draftId === input.draftId)
      if (!draft) return
      const content = {
        type: "session" as const,
        directory: input.directory,
        sessionId: input.sessionId,
        title: input.title ?? draft.content?.title,
        ...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
      }
      meta.patch(draft.id, {
        type: "session",
        scope: "directory",
        directory: input.directory,
        sessionId: input.sessionId,
        providerDirectory: undefined,
        draftId: undefined,
        draftPanel: undefined,
        draftProjectId: undefined,
        content,
      })
      for (const duplicate of meta.findAll((m) =>
        m.type === "session" && m.sessionId === input.sessionId && m.id !== draft.id
      )) {
        wb.contents.remove(duplicate.id)
        _cleanupOnClose(duplicate.id, "merge")
      }
      return draft.id
    },

    openTerminal(directory, terminalId, title, opts) {
      const existing = meta.find(
        (m) => m.type === "terminal" && m.directory === directory && m.terminalId === terminalId,
      )
      if (existing) patchTerminalTitle(existing, directory, terminalId, title)
      return showOrCreate(
        existing,
        () => {
          const id = newId("terminal")
          return {
            meta: {
              id,
              type: "terminal",
              scope: "directory",
              directory,
              terminalId,
            },
            payload: {
              type: "terminal",
              directory,
              terminalId,
              title,
              ...(opts?.command ? { command: opts.command } : {}),
            },
          }
        },
        opts,
      )
    },

    openPage(pageId, title, directory, filePath) {
      const existing = meta.find((m) => m.type === "page" && m.pageId === pageId)
      if (existing) {
        const updates: Partial<ContentMeta> = {}
        if (directory && existing.directory !== directory) updates.directory = directory
        if (filePath && existing.filePath !== filePath) updates.filePath = filePath
        if (Object.keys(updates).length > 0) meta.patch(existing.id, updates)
        wb.navigation.show(existing.id)
        return existing.id
      }
      const id = newId("page")
      const next: ContentMeta = {
        id,
        type: "page",
        scope: directory ? "directory" : "global",
        ...(directory ? { directory } : {}),
        pageId,
        filePath,
        content: {
          type: "page",
          pageId,
          title,
          filePath,
          ...(directory ? { directory } : {}),
        },
      }
      meta.upsert(next)
      addContent(id)
      wb.navigation.show(id)
      return id
    },

    openPagesIndex(directory) {
      const existing = meta.find((m) => m.type === "pages-index" && m.directory === directory)
      return showOrCreate(existing, () => {
        const id = newId("pages-index")
        return {
          meta: {
            id,
            type: "pages-index",
            scope: directory ? "directory" : "global",
            ...(directory ? { directory } : {}),
          },
          payload: {
            type: "pages-index",
            ...(directory ? { directory } : {}),
          },
        }
      })
    },

    openMarketplace() {
      // Marketplace is a single global tab — workspace-independent.
      const existing = meta.find((m) => m.type === "marketplace")
      return showOrCreate(existing, () => {
        const id = newId("marketplace")
        return {
          meta: {
            id,
            type: "marketplace",
            scope: "global",
          },
          payload: {
            type: "marketplace",
            title: "Marketplace",
          },
        }
      })
    },

    openWorkGraph() {
      const existing = meta.find((m) => m.type === "workgraph")
      if (existing) {
        meta.patch(existing.id, { content: { type: "workgraph", title: "WorkGraph" } })
        wb.navigation.show(existing.id)
        return existing.id
      }
      const id = newId("workgraph")
      meta.upsert({ id, type: "workgraph", scope: "global", content: { type: "workgraph", title: "WorkGraph" } })
      addContent(id)
      wb.navigation.show(id)
      return id
    },

    openWorkspaceWorkGraph(directory) {
      return showOrCreate(
        meta.find((item) => item.type === "workspace-workgraph" && item.directory === directory),
        () => {
          const id = newId("workspace-workgraph")
          return {
            meta: { id, type: "workspace-workgraph", scope: "directory", directory },
            payload: {
              type: "workspace-workgraph",
              directory,
              title: "Project WorkGraph",
            },
          }
        },
      )
    },

    openTaskComposer(directory) {
      return showOrCreate(
        meta.find((item) => item.type === "task-composer" && item.directory === directory),
        () => {
          const id = newId("task-composer")
          return {
            meta: {
              id,
              type: "task-composer",
              scope: directory ? "directory" : "global",
              ...(directory ? { directory } : {}),
            },
            payload: {
              type: "task-composer",
              ...(directory ? { directory } : {}),
              title: "New task",
            },
          }
        },
      )
    },

    closeContent(id, reason = "user") {
      const m = meta.get(id)
      // Pinned built-ins: refuse to close.
      if (m && PINNED_TYPES.has(m.type)) return
      // Record a user close so the route layer (route-intent receive / the
      // directSessionRouteId effect / inventory ticks) does not immediately
      // re-materialize the session as a new tab. This is the single chokepoint
      // every close path funnels through, so recording here covers compact-tab,
      // sidebar, and keyboard closes alike — regardless of focus. Merge/dedup
      // closes are not user intent and must NOT be recorded.
      if (
        reason === "user" &&
        m &&
        (m.type === "session" || m.type === "context") &&
        m.sessionId &&
        m.sessionId !== "new"
      ) {
        markRouteIntentClosed({ sessionId: m.sessionId })
        if (m.directory) markRouteIntentClosed({ workspaceId: m.directory, sessionId: m.sessionId })
      }
      // wb.contents.remove triggers _cleanupOnClose via the workbench's
      // onContentClose hook — but we also call it directly so this method
      // works whether or not the provider has wired the hook.
      wb.contents.remove(id)
      _cleanupOnClose(id, reason)
    },

    closePane(paneId, opts) {
      wb.split.close(paneId, { destroyContent: opts?.destroyContent ?? false })
    },

    moveContent(id, fromPane, toPane) {
      wb.split.move(id, fromPane, toPane)
    },

    splitContent(targetPane, edge, id) {
      wb.split.split(targetPane, edge, id)
    },

    showContent(id) {
      wb.navigation.show(id)
    },

    restoreContentFocus,

    _cleanupOnClose,
  }
}
