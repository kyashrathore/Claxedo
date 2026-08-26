/**
 * Claxedo-owned store of page-element comments authored from the browser
 * pane. The feature's data model is kept **deliberately outside** upstream's
 * `ContextItem` union — `PageElementComment` and its payload type live only
 * here, and the only seam that crosses into upstream's pipeline is the thin
 * `build-request-parts` override which appends synthetic parts at submit
 * time.
 *
 * Design notes:
 *   - Entries are keyed by `sessionId` for the submit-time adapter and by
 *     `tabId` for the producer pane's history view.
 *   - `pending(sessionId)` is the queue the submit-time override drains. On
 *     successful send, submit calls `clearPending(sessionId)`.
 *   - Persistence uses the same `Persist.global(...)` key shape as other
 *     claxedo-app stores (notifications, layout, etc.) so the legacy-key
 *     fallback pattern stays consistent.
 *   - The store is a solid-js `createStore`, which provides per-entry
 *     reactivity to consumers without them needing to re-read `list()` or
 *     `pending()` manually.
 */

import { createSimpleContext } from "@opencode-ai/ui/context"
import { createStore } from "solid-js"
import { createMemo, type Accessor } from "solid-js"
import { Persist, persisted } from "@/platform/persistence/persist"

export type PageElementCommentBoundingBox = {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The canonical persisted shape of a page-element comment. Owned by the
 * claxedo browser feature; upstream code must never know this type exists.
 */
export type PageElementComment = {
  id: string
  tabId: string
  sessionId?: string
  pageUrl: string
  selector: string
  comment: string
  noteText: string
  boundingBox?: PageElementCommentBoundingBox
  outerHTML?: string
  screenshotDataUrl?: string
  createdAt: number
}

/**
 * The payload a browser-pane producer sends to a session consumer through
 * the pane-bus. Differs from `PageElementComment` in two ways:
 *   - no `id` (the receiver mints one on enqueue),
 *   - no `sessionId` (the consumer supplies its own).
 */
export type PageElementCommentPayload = {
  tabId: string
  pageUrl: string
  selector: string
  comment: string
  noteText: string
  boundingBox?: PageElementCommentBoundingBox
  outerHTML?: string
  screenshotDataUrl?: string
}

type BrowserCommentsStore = {
  items: PageElementComment[]
}

export type BrowserCommentsState = {
  list: (tabId: string) => PageElementComment[]
  pending: (sessionId: string) => PageElementComment[]
  add: (entry: Omit<PageElementComment, "id" | "createdAt"> & { id?: string; createdAt?: number }) => PageElementComment
  enqueue: (sessionId: string, payload: PageElementCommentPayload) => PageElementComment
  remove: (id: string) => void
  update: (id: string, patch: Partial<PageElementComment>) => void
  clearPending: (sessionId: string) => void
  ready: Accessor<boolean>
}

const generateId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `pec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export const PERSIST_KEY = "browser.comments.v1"

const browserCommentsContextInput = {
  name: "BrowserComments",
  // Provider renders children immediately; hydration happens asynchronously
  // but the store starts with `items: []` so reads are always safe.
  gate: false,
  init: (): BrowserCommentsState => {
    const [store, setStore, _rawInit, ready] = persisted(
      Persist.global(PERSIST_KEY, []),
      createStore<BrowserCommentsStore>({ items: [] }),
    )

    const add: BrowserCommentsState["add"] = (entry) => {
      const next: PageElementComment = {
        id: entry.id ?? generateId(),
        tabId: entry.tabId,
        sessionId: entry.sessionId,
        pageUrl: entry.pageUrl,
        selector: entry.selector,
        comment: entry.comment,
        noteText: entry.noteText,
        boundingBox: entry.boundingBox,
        outerHTML: entry.outerHTML,
        screenshotDataUrl: entry.screenshotDataUrl,
        createdAt: entry.createdAt ?? Date.now(),
      }
      setStore(($state) => {
        const list = $state["items"]
        list.push(next)
      })
      return next
    }

    const enqueue: BrowserCommentsState["enqueue"] = (sessionId, payload) => {
      return add({
        tabId: payload.tabId,
        sessionId,
        pageUrl: payload.pageUrl,
        selector: payload.selector,
        comment: payload.comment,
        noteText: payload.noteText,
        boundingBox: payload.boundingBox,
        outerHTML: payload.outerHTML,
        screenshotDataUrl: payload.screenshotDataUrl,
      })
    }

    const remove: BrowserCommentsState["remove"] = (id) => {
      setStore(($state) => {
        const items = $state["items"]
        const idx = items.findIndex((e) => e.id === id)
        if (idx >= 0) items.splice(idx, 1)
      })
    }

    const update: BrowserCommentsState["update"] = (id, patch) => {
      setStore(($state) => {
        const items = $state["items"]
        const idx = items.findIndex((e) => e.id === id)
        if (idx < 0) return
        items[idx] = { ...items[idx], ...patch, id: items[idx].id }
      })
    }

    const clearPending: BrowserCommentsState["clearPending"] = (sessionId) => {
      setStore(($state) => {
        const items = $state["items"]
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i].sessionId === sessionId) items.splice(i, 1)
        }
      })
    }

    const list: BrowserCommentsState["list"] = (tabId) =>
      store.items
        .filter((e) => e.tabId === tabId)
        .sort((a, b) => a.createdAt - b.createdAt)

    const pending: BrowserCommentsState["pending"] = (sessionId) =>
      store.items
        .filter((e) => e.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt)

    return {
      list,
      pending,
      add,
      enqueue,
      remove,
      update,
      clearPending,
      ready: createMemo(() => ready()),
    }
  },
}
const browserCommentsContext = createSimpleContext<
  ReturnType<typeof browserCommentsContextInput.init>,
  Record<string, any>
>(browserCommentsContextInput)

export function useBrowserComments() {
  return browserCommentsContext.use()
}

export const BrowserCommentsProvider = browserCommentsContext.provider
