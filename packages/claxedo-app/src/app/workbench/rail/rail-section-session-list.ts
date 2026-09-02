import { createEffect, createMemo, createSignal, on } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { queryClient } from "@/platform/query/query-client"
import {
  appendSessionListPageQueryData,
  type SessionListQuery,
  type SessionListResponse,
} from "@/features/session/data/query/session-list"
import {
  sessionSourceQueryOptions,
  type SessionSource,
} from "@/features/session/data/sync/session-source"
import {
  reconcileSessionRowsAfterArchive,
  type SessionNavigationRow,
} from "@/features/session/ui/navigation/session-navigation"

/**
 * One rail section's rendered session list.
 *
 * The rail has three section shapes — Global Chat, a project, a workspace — and
 * each of them renders the same thing: the first page of a list, a "Load more"
 * that appends the next one, and the loading/empty/error/done states the header
 * shows. That is the whole of this module, so a change to how a section pages
 * or reports its state is one edit rather than three.
 *
 * The SOURCE is the section's own: `sessionSourceQueryOptions` chooses it from
 * the workspace's catalog kind. Everything here is source-agnostic, because
 * every source writes the same `shell.sessionList` cache entry.
 */
export type RailSectionSessionList = ReturnType<typeof createRailSectionSessionList>

export function createRailSectionSessionList(input: {
  baseUrl: () => string | undefined
  source: () => SessionSource
  query: () => SessionListQuery
  archiveView: () => SessionListQuery["archived"]
  /** A collapsed section renders nothing, so it must not fetch either. */
  enabled?: () => boolean
}) {
  const signature = createMemo(() => JSON.stringify(input.query()))
  const sourceSignature = createMemo(() => JSON.stringify(input.source()))
  const query = useQuery(() => ({
    ...sessionSourceQueryOptions({
      baseUrl: input.baseUrl(),
      source: input.source(),
      query: input.query(),
    }),
    ...(input.enabled ? { enabled: input.enabled() } : {}),
  }))
  // The source is not part of the cache key — every source writes the section's
  // one `shell.sessionList` entry — so a source that gains a member (the
  // catalog answering after the rail mounted, a workspace shared with this
  // account) answers the SAME query with more rows. Nothing else would ask it
  // again: the key is unchanged, so the cached page would stand.
  createEffect(on(sourceSignature, () => {
    if (input.enabled && !input.enabled()) return
    void query.refetch()
  }, { defer: true }))
  const [rows, setRows] = createSignal<SessionNavigationRow[]>([])
  const [nextCursor, setNextCursor] = createSignal<string | undefined>()
  const [total, setTotal] = createSignal<number | undefined>()
  const [loadedSignature, setLoadedSignature] = createSignal<string | undefined>()
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [pageError, setPageError] = createSignal(false)
  let loadingCursor: string | undefined

  createEffect(() => {
    const data = query.data
    if (!data) return
    setRows(data.items ?? [])
    setNextCursor(data.nextCursor)
    setTotal(data.totalKnown)
    setLoadedSignature(signature())
    setPageError(false)
  })

  // A view change (archive toggle, filter) mints a new query; until its own
  // page lands, the section is not "loaded" and must not render the previous
  // view's rows as if they answered this one.
  const loaded = createMemo(() => loadedSignature() === signature())
  const more = createMemo(() => loaded() && !!nextCursor())
  const count = createMemo(() => loaded() ? total() ?? rows().length : 0)

  return {
    rows,
    loaded,
    more,
    count,
    loadingMore,
    pageError,
    isFetching: () => query.isFetching,
    isError: () => query.isError,
    retry: () => query.refetch(),
    loadMore: async (pageSize: number) => {
      const cursor = nextCursor()
      if (!cursor || loadingCursor === cursor) return
      const requested = signature()
      loadingCursor = cursor
      setLoadingMore(true)
      setPageError(false)
      try {
        const page = await queryClient.fetchQuery(sessionSourceQueryOptions({
          baseUrl: input.baseUrl(),
          source: input.source(),
          query: { ...input.query(), cursor, limit: pageSize },
        })) as SessionListResponse
        if (requested !== signature()) return
        const next = appendSessionListPageQueryData({
          baseUrl: input.baseUrl(),
          query: input.query(),
          page,
        })
        setRows(next.items ?? [])
        setNextCursor(next.nextCursor)
        setTotal(next.totalKnown)
        setLoadedSignature(requested)
      } catch {
        if (requested === signature()) setPageError(true)
      } finally {
        if (loadingCursor === cursor) loadingCursor = undefined
        setLoadingMore(false)
      }
    },
    /** Optimistic archive: the row leaves (or is stamped) before the refetch. */
    reconcileArchived: (sessionRef: string) => {
      const current = rows()
      const next = reconcileSessionRowsAfterArchive({
        rows: current,
        sessionRef,
        archivedAt: Date.now(),
        archiveView: input.archiveView() ?? "active",
      })
      setRows(next)
      if (input.archiveView() === "active" && next.length < current.length) {
        setTotal((value) => value === undefined ? value : Math.max(0, value - (current.length - next.length)))
      }
    },
  }
}
