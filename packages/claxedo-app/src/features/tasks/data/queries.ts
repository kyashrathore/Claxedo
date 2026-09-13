import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, type Accessor } from "solid-js"
import type { Page, Preset, Task, TaskSummary, TasksCapabilities, TaskSessionLinkView } from "@claxedo/tasks"
import type { ListFailure } from "../ui/shared/list-failure"
import type { MorePages } from "../ui/shared/load-more"
import { useTasksAppPorts, type TasksScope } from "../app-ports"
import { createTasksApi, refusalOf, tasksQueryKeys, type TaskListFilter } from "./tasks-api"

export type { TasksScope } from "../app-ports"

export function useTasksScope(): Accessor<TasksScope> {
  return useTasksAppPorts().useScope()
}

export function useTasksClient() {
  const ports = useTasksAppPorts()
  const scope = useTasksScope()
  return createMemo(() => createTasksApi({ serverUrl: scope().serverUrl, request: ports.request }))
}

export function useTasksCapabilities(scope: Accessor<TasksScope>) {
  const client = useTasksClient()
  return useQuery<TasksCapabilities>(() => ({
    queryKey: tasksQueryKeys(scope()).capabilities,
    staleTime: 5 * 60_000,
    queryFn: () => client().capabilities(),
  }))
}

/**
 * A cursor-following list read. `items` holds every page fetched so far, and
 * `hasMore` is the server's own `nextCursor` — never inferred from the page
 * size, which cannot tell a full last page from a truncated one.
 *
 * `error` and `moreError` partition the one query error: `error` is the failure
 * of the list read itself, `moreError` the failure of a page after the first,
 * which leaves what was already read intact. Each has its own retry: `retry`
 * runs the read again, `loadMore` resumes at the outstanding cursor.
 */
export type PagedList<T> = {
  items: Accessor<readonly T[]>
  pending: Accessor<boolean>
  error: Accessor<unknown>
  retrying: Accessor<boolean>
  retry: () => void
  hasMore: Accessor<boolean>
  loadingMore: Accessor<boolean>
  moreError: Accessor<unknown>
  loadMore: () => void
}

function pagedList<T>(
  options: () => {
    queryKey: readonly unknown[]
    enabled?: boolean
    page: (cursor: string | undefined) => Promise<Page<T>>
  },
): PagedList<T> {
  const query = useInfiniteQuery(() => {
    const current = options()
    return {
      queryKey: current.queryKey,
      enabled: current.enabled,
      initialPageParam: undefined as string | undefined,
      queryFn: (context: { pageParam: string | undefined }) => current.page(context.pageParam),
      getNextPageParam: (last: Page<T>) => last.nextCursor ?? undefined,
    }
  })
  const items = createMemo<readonly T[]>(() => (query.data?.pages ?? []).flatMap((page) => page.items))
  return {
    items,
    pending: () => query.isPending,
    // The query reports "no error" as `null`, which every caller here would
    // otherwise have to read as a failure it can render.
    error: () => (query.isFetchNextPageError ? undefined : (query.error ?? undefined)),
    retrying: () => query.isFetching && !query.isFetchingNextPage,
    retry: () => void query.refetch(),
    hasMore: () => query.hasNextPage,
    loadingMore: () => query.isFetchingNextPage,
    moreError: () => (query.isFetchNextPageError ? (query.error ?? undefined) : undefined),
    loadMore: () => void query.fetchNextPage(),
  }
}

/**
 * The refusal a list read came back with, and the retry for it. A surface that
 * renders this must not also render its empty state: the list was not read.
 */
export function listFailure(list: PagedList<unknown>): ListFailure | undefined {
  const failure = list.error()
  if (failure === undefined) return undefined
  return { message: refusalOf(failure).message, onRetry: () => list.retry(), retrying: list.retrying() }
}

/** The next-page control for a list the user pages by hand. */
export function morePages(list: PagedList<unknown>): MorePages | undefined {
  return list.hasMore() ? nextPageControl(list) : undefined
}

/**
 * The next-page control for a followed list: absent while following works, and
 * the retry that resumes following once a page has failed.
 */
export function followRetry(list: PagedList<unknown>): MorePages | undefined {
  return list.moreError() === undefined ? undefined : nextPageControl(list)
}

function nextPageControl(list: PagedList<unknown>): MorePages {
  const failure = list.moreError()
  return {
    onLoadMore: () => list.loadMore(),
    loading: list.loadingMore(),
    ...(failure === undefined ? {} : { error: refusalOf(failure).message }),
  }
}

function followEveryPage(list: PagedList<unknown>) {
  createEffect(() => {
    // A failed page leaves `hasMore` true with nothing in flight: without this
    // stop, the effect re-requests the same failing page for as long as the
    // view stays mounted.
    if (list.moreError() !== undefined) return
    if (list.hasMore() && !list.loadingMore()) list.loadMore()
  })
}

export function usePresetList(scope: Accessor<TasksScope>, includeArchived: Accessor<boolean>): PagedList<Preset> {
  const client = useTasksClient()
  const list = pagedList<Preset>(() => ({
    queryKey: tasksQueryKeys(scope()).presets(includeArchived()),
    page: (cursor) => client().listPresets({ includeArchived: includeArchived(), cursor: cursor ?? null }),
  }))
  // Start offers presets in a chooser, which has nowhere to put a control: an
  // unfollowed cursor would hide older presets behind no visible affordance.
  followEveryPage(list)
  return list
}

export function useTaskList(
  scope: Accessor<TasksScope>,
  filter: Accessor<TaskListFilter | undefined>,
): PagedList<TaskSummary> {
  const client = useTasksClient()
  return pagedList<TaskSummary>(() => {
    const current = filter()
    return {
      queryKey: tasksQueryKeys(scope()).list(current ?? { projectId: "", status: null, parent: "any", includeArchived: false }),
      enabled: !!current?.projectId,
      page: (cursor) => client().listTasks({ ...current!, cursor: cursor ?? null }),
    }
  })
}

export type TaskDetail = { task: Task; links: readonly TaskSessionLinkView[] }

export function useTaskDetail(scope: Accessor<TasksScope>, taskId: Accessor<string | undefined>) {
  const client = useTasksClient()
  return useQuery<TaskDetail | null>(() => {
    const id = taskId()
    return {
      queryKey: tasksQueryKeys(scope()).detail(id ?? ""),
      enabled: !!id,
      queryFn: () => client().getTask(id!),
    }
  })
}

export function useTaskChildren(
  scope: Accessor<TasksScope>,
  taskId: Accessor<string | undefined>,
): PagedList<TaskSummary> {
  const client = useTasksClient()
  const list = pagedList<TaskSummary>(() => {
    const id = taskId()
    return {
      queryKey: tasksQueryKeys(scope()).children(id ?? ""),
      enabled: !!id,
      page: (cursor) => client().listChildren(id!, { cursor: cursor ?? null }),
    }
  })
  // The server refuses Done over every unfinished child it holds, so a page
  // boundary here would refuse against a child this panel never showed.
  followEveryPage(list)
  return list
}

/**
 * One invalidation entry point. Every mutation goes through the server and then
 * re-reads; nothing here writes a query cache entry, so a refused command can
 * never leave the client showing a change the server did not make.
 */
export function useTasksInvalidation(scope: Accessor<TasksScope>) {
  const queryClient = useQueryClient()
  const everything = () => queryClient.invalidateQueries({ queryKey: tasksQueryKeys(scope()).scope })
  return {
    everything,
    /**
     * What a command against one task is followed by: its own entries, then
     * every list that may name it. Awaiting the second is what lets a caller
     * navigate or report only once the re-read is in flight.
     */
    afterCommand: async (taskId: string) => {
      void queryClient.invalidateQueries({ queryKey: tasksQueryKeys(scope()).detail(taskId) })
      void queryClient.invalidateQueries({ queryKey: tasksQueryKeys(scope()).children(taskId) })
      await everything()
    },
  }
}
