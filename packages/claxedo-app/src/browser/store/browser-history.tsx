/**
 * Claxedo-owned browser-tab history store.
 *
 * Persisted under `Persist.global("browser.history.v1", [])`. Tracks two
 * shapes:
 *
 *   - `recent`:  a newest-first list of visited URLs (capped at
 *     `RECENT_CAP`), used by the address-bar autocomplete.
 *   - `perTab`:  a map of `browserId → back/forward history` (each capped at
 *     `PER_TAB_CAP`) for per-tab navigation memory.
 *
 * The store is deliberately not coupled to upstream primitives — the browser
 * feature owns its own history (see the 2026-04-21 plan, "Architectural
 * Direction" point #2). Closing and reopening a browser tab restores URL +
 * title via the existing `closedTabs` persistence on `ClaxedoLayout`; this
 * store adds the cross-tab recents list the address bar needs and a per-tab
 * back/forward stack independent of the webview's in-memory navigation.
 *
 * Fuzzy matching primitive is not available in the repo; autocomplete uses
 * case-insensitive substring matching with order-by-recency (see
 * `matchRecent`). This is sufficient for v1 per the plan.
 */

import { createSimpleContext } from "@opencode-ai/ui/context"
import { createStore, produce } from "solid-js/store"
import { createMemo, type Accessor } from "solid-js"
import { Persist, persisted } from "@/utils/persist"

export const RECENT_CAP = 50
export const PER_TAB_CAP = 50

export type RecentEntry = {
  /** Normalized URL we matched against. */
  url: string
  /** Last-seen page title (empty string if unknown). */
  title: string
  /** Timestamp of the last visit — newest first. */
  lastVisitedAt: number
  /** Total number of visits, used to break ties when sorting. */
  visitCount: number
}

export type PerTabHistoryEntry = {
  url: string
  title: string
  visitedAt: number
}

export type BrowserHistoryStore = {
  recent: RecentEntry[]
  perTab: Record<string, PerTabHistoryEntry[]>
}

export type BrowserHistoryState = {
  /** Full recent list newest-first, capped at `RECENT_CAP`. */
  recent: Accessor<RecentEntry[]>
  /** Per-tab visit history, capped at `PER_TAB_CAP` per tab. */
  tabHistory: (browserId: string) => PerTabHistoryEntry[]
  /** Record a visit on a tab. Also bumps the global recents list. */
  visit: (input: { browserId: string; url: string; title?: string; at?: number }) => void
  /** Autocomplete helper — case-insensitive substring match, sorted by recency. */
  matchRecent: (query: string, limit?: number) => RecentEntry[]
  /** Drop a browser tab's history (called when a tab is permanently destroyed). */
  forgetTab: (browserId: string) => void
  /** Wipe all history. */
  clear: () => void
  ready: Accessor<boolean>
}

export const PERSIST_KEY = "browser.history.v1"

const normalizeUrl = (raw: string): string => {
  if (!raw) return ""
  return raw.trim()
}

/**
 * Exported for tests — the internal reducer that updates the store on a
 * visit. Kept pure so we can unit-test capping and ordering without a
 * SolidJS root.
 */
export function applyVisit(
  store: BrowserHistoryStore,
  input: { browserId: string; url: string; title?: string; at?: number },
): BrowserHistoryStore {
  const url = normalizeUrl(input.url)
  if (!url) return store
  const at = input.at ?? Date.now()
  const title = input.title ?? ""

  const recent = (() => {
    const idx = store.recent.findIndex((e) => e.url === url)
    if (idx >= 0) {
      const prev = store.recent[idx]
      const updated: RecentEntry = {
        url,
        title: title || prev.title,
        lastVisitedAt: at,
        visitCount: prev.visitCount + 1,
      }
      const list = [updated, ...store.recent.slice(0, idx), ...store.recent.slice(idx + 1)]
      return list.slice(0, RECENT_CAP)
    }
    const next: RecentEntry = {
      url,
      title,
      lastVisitedAt: at,
      visitCount: 1,
    }
    return [next, ...store.recent].slice(0, RECENT_CAP)
  })()

  const tabList = store.perTab[input.browserId] ?? []
  const last = tabList[tabList.length - 1]
  const perTabEntries = (() => {
    // Skip a duplicate entry if the top of the stack is the same URL —
    // common when `did-navigate` fires twice for the same resource.
    if (last && last.url === url) {
      return [
        ...tabList.slice(0, -1),
        { url, title: title || last.title, visitedAt: at },
      ]
    }
    const next: PerTabHistoryEntry = { url, title, visitedAt: at }
    const list = [...tabList, next]
    return list.length > PER_TAB_CAP ? list.slice(list.length - PER_TAB_CAP) : list
  })()

  return {
    recent,
    perTab: { ...store.perTab, [input.browserId]: perTabEntries },
  }
}

/**
 * Exported for tests — case-insensitive substring + prefix priority.
 * Sort order:
 *   1. exact match
 *   2. prefix match (URL starts with query), newest first
 *   3. substring match on URL, newest first
 *   4. substring match on title, newest first
 */
export function matchRecentPure(list: RecentEntry[], query: string, limit = 10): RecentEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return list.slice(0, limit)
  const exact: RecentEntry[] = []
  const prefix: RecentEntry[] = []
  const urlSub: RecentEntry[] = []
  const titleSub: RecentEntry[] = []
  for (const e of list) {
    const url = e.url.toLowerCase()
    const title = e.title.toLowerCase()
    if (url === q) {
      exact.push(e)
      continue
    }
    if (url.startsWith(q)) {
      prefix.push(e)
      continue
    }
    if (url.includes(q)) {
      urlSub.push(e)
      continue
    }
    if (title.includes(q)) {
      titleSub.push(e)
      continue
    }
  }
  const byRecency = (a: RecentEntry, b: RecentEntry) => b.lastVisitedAt - a.lastVisitedAt
  const merged = [
    ...exact.sort(byRecency),
    ...prefix.sort(byRecency),
    ...urlSub.sort(byRecency),
    ...titleSub.sort(byRecency),
  ]
  return merged.slice(0, limit)
}

const browserHistoryContextInput = {
  name: "BrowserHistory",
  gate: false,
  init: (): BrowserHistoryState => {
    const [store, setStore, _rawInit, ready] = persisted(
      Persist.global(PERSIST_KEY, []),
      createStore<BrowserHistoryStore>({ recent: [], perTab: {} }),
    )

    const visit: BrowserHistoryState["visit"] = (input) => {
      const url = normalizeUrl(input.url)
      if (!url) return
      setStore(
        produce((draft: BrowserHistoryStore) => {
          const next = applyVisit(draft, { ...input, url })
          draft.recent = next.recent
          draft.perTab = next.perTab
        }),
      )
    }

    const forgetTab: BrowserHistoryState["forgetTab"] = (browserId) => {
      setStore(
        produce((draft: BrowserHistoryStore) => {
          if (draft.perTab[browserId]) delete draft.perTab[browserId]
        }),
      )
    }

    const clear: BrowserHistoryState["clear"] = () => {
      setStore(
        produce((draft: BrowserHistoryStore) => {
          draft.recent = []
          draft.perTab = {}
        }),
      )
    }

    const recent: BrowserHistoryState["recent"] = () => store.recent
    const tabHistory: BrowserHistoryState["tabHistory"] = (browserId) => store.perTab[browserId] ?? []
    const matchRecent: BrowserHistoryState["matchRecent"] = (query, limit) =>
      matchRecentPure(store.recent, query, limit)

    return {
      recent,
      tabHistory,
      visit,
      matchRecent,
      forgetTab,
      clear,
      ready: createMemo(() => ready()),
    }
  },
}
const browserHistoryContext = createSimpleContext<ReturnType<typeof browserHistoryContextInput.init>, Record<string, any>>(browserHistoryContextInput)

export function useBrowserHistory() {
  return browserHistoryContext.use()
}

export const BrowserHistoryProvider = browserHistoryContext.provider
