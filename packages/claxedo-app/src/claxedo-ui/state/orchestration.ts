// Orchestration — `state.layout.openX` / `closeContent` / `closePane` etc.
//
// These are the high-level "user did a thing" actions that cross slice
// boundaries. Each action:
//   1. Looks up an existing meta entry by identity (directory+sessionId etc.)
//   2. If present, focuses it via `wb.navigation.show`.
//   3. Otherwise creates a new meta entry, calls `wb.contents.add`, then shows.
//
// One content is one tab: each `contentId` is the same id the Workbench uses
// and lives in `state.meta`.

import type { ContentMeta, ContentPayload, ContentType } from "./types"
import type { Edge, UseWorkbench } from "../layout"
import type { MetadataSliceApi } from "./metadata"
import type { TerminalSliceApi } from "./terminal"

export type ContentCloseReason = "user" | "panic" | "merge"

export type CleanupHook = (id: string, meta: ContentMeta | undefined, reason: ContentCloseReason) => void

export type LayoutOrchestrationApi = {
  openSession(directory: string, sessionId: string, title?: string, opts?: { focus?: boolean }): string
  openDraftSession(providerDirectory: string, draftId: string, opts?: { focus?: boolean }): string
  openTerminal(directory: string, terminalId: string, title?: string, opts?: { focus?: boolean; command?: string }): string
  openPage(pageId: string, title?: string, directory?: string, filePath?: string): string
  openPagesIndex(directory?: string): string
  openWorkgraph(directory?: string): string
  openContext(directory: string, sessionId: string, title?: string): string
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

  /**
   * Internal hook the rail-layout's `onContentClose` calls when the Workbench
   * removes a content (drag-drop merge or split-close with destroyContent).
   * Cleans up meta + per-type state without touching the workbench.
   */
  _cleanupOnClose(id: string, reason: ContentCloseReason): void
}

const PINNED_TYPES: ReadonlySet<ContentType> = new Set(["pages-index", "workgraph"])

const newId = (type: ContentType) => {
  const prefix = type === "workgraph" ? "wkg" : type
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export function createLayoutOrchestration(input: {
  wb: UseWorkbench
  meta: MetadataSliceApi
  terminal: TerminalSliceApi
  /** Called per-type after the Workbench removes content. */
  cleanupHook?: CleanupHook
}): LayoutOrchestrationApi {
  const { wb, meta, terminal, cleanupHook } = input

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
    wb.contents.add(nextMeta.id)
    if (opts?.focus !== false) wb.navigation.show(nextMeta.id)
    return nextMeta.id
  }

  const _cleanupOnClose: LayoutOrchestrationApi["_cleanupOnClose"] = (id, reason) => {
    const m = meta.get(id)
    // Per-type cleanup
    if (m?.type === "terminal" && m.terminalId) {
      terminal.clearForContent(id)
    }
    cleanupHook?.(id, m, reason)
    meta.remove(id)
  }

  return {
    openSession(directory, sessionId, title, opts) {
      const existing = meta.find(
        (m) => m.type === "session" && m.directory === directory && m.sessionId === sessionId,
      )
      return showOrCreate(
        existing,
        () => {
          const id = newId("session")
          return {
            meta: {
              id,
              type: "session",
              scope: "directory",
              directory,
              sessionId,
            },
            payload: { type: "session", directory, sessionId, title },
          }
        },
        opts,
      )
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

    openTerminal(directory, terminalId, title, opts) {
      const existing = meta.find(
        (m) => m.type === "terminal" && m.directory === directory && m.terminalId === terminalId,
      )
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
      wb.contents.add(id)
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

    openWorkgraph(directory) {
      const existing = meta.find((m) => m.type === "workgraph" && m.directory === directory)
      return showOrCreate(existing, () => {
        const id = newId("workgraph")
        return {
          meta: {
            id,
            type: "workgraph",
            scope: directory ? "directory" : "global",
            ...(directory ? { directory } : {}),
          },
          payload: {
            type: "workgraph",
            ...(directory ? { directory } : {}),
          },
        }
      })
    },

    openContext(directory, sessionId, title) {
      const existing = meta.find(
        (m) => m.type === "context" && m.directory === directory && m.sessionId === sessionId,
      )
      return showOrCreate(existing, () => {
        const id = newId("context")
        return {
          meta: {
            id,
            type: "context",
            scope: "directory",
            directory,
            sessionId,
          },
          payload: { type: "context", directory, sessionId, title },
        }
      })
    },

    closeContent(id, reason = "user") {
      const m = meta.get(id)
      // Pinned built-ins: refuse to close.
      if (m && PINNED_TYPES.has(m.type)) return
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

    _cleanupOnClose,
  }
}
