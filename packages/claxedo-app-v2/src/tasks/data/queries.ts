import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, type Accessor } from "solid-js"
import type { Page, Preset, TaskDetailResponse, TaskSummary } from "@claxedo/tasks"
import { useServer } from "@/server"
import { refusalOf, type TaskListFilter } from "./refusal"

export type PagedList<T> = {
  readonly items: Accessor<readonly T[]>
  readonly pending: Accessor<boolean>
  readonly error: Accessor<unknown>
  readonly retrying: Accessor<boolean>
  readonly retry: () => void
  readonly hasMore: Accessor<boolean>
  readonly loadingMore: Accessor<boolean>
  readonly moreError: Accessor<unknown>
  readonly loadMore: () => void
}

export type ListFailure = { readonly message: string; readonly onRetry: () => void; readonly retrying?: boolean }

export type MorePages = { readonly onLoadMore: () => void; readonly loading?: boolean; readonly error?: string }

export function useTasksApi() {
  return useServer().tasks
}

function pagedList<T>(
  options: () => {
    readonly queryKey: readonly unknown[]
    readonly enabled?: boolean
    readonly page: (cursor: string | undefined) => Promise<Page<T>>
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
    error: () => (query.isFetchNextPageError ? undefined : (query.error ?? undefined)),
    retrying: () => query.isFetching && !query.isFetchingNextPage,
    retry: () => void query.refetch(),
    hasMore: () => query.hasNextPage,
    loadingMore: () => query.isFetchingNextPage,
    moreError: () => (query.isFetchNextPageError ? (query.error ?? undefined) : undefined),
    loadMore: () => void query.fetchNextPage(),
  }
}

export function listFailure(list: PagedList<unknown>): ListFailure | undefined {
  const failure = list.error()
  if (failure === undefined) return undefined
  return { message: refusalOf(failure).message, onRetry: () => list.retry(), retrying: list.retrying() }
}

function nextPageControl(list: PagedList<unknown>): MorePages {
  const failure = list.moreError()
  return {
    onLoadMore: () => list.loadMore(),
    loading: list.loadingMore(),
    ...(failure === undefined ? {} : { error: refusalOf(failure).message }),
  }
}

export function morePages(list: PagedList<unknown>): MorePages | undefined {
  return list.hasMore() ? nextPageControl(list) : undefined
}

export function followRetry(list: PagedList<unknown>): MorePages | undefined {
  return list.moreError() === undefined ? undefined : nextPageControl(list)
}

function followEveryPage(list: PagedList<unknown>) {
  createEffect(() => {
    if (list.moreError() !== undefined) return
    if (list.hasMore() && !list.loadingMore()) list.loadMore()
  })
}

export function usePresetList(includeArchived: Accessor<boolean>): PagedList<Preset> {
  const api = useTasksApi()
  const list = pagedList<Preset>(() => ({
    queryKey: api.keys.presets(includeArchived()),
    page: (cursor) => api.client.listPresets({ includeArchived: includeArchived(), cursor: cursor ?? null }),
  }))
  followEveryPage(list)
  return list
}

const NO_FILTER: TaskListFilter = { projectId: "", status: null, parent: "any", includeArchived: false }

export function useTaskList(filter: Accessor<TaskListFilter | undefined>): PagedList<TaskSummary> {
  const api = useTasksApi()
  return pagedList<TaskSummary>(() => {
    const current = filter() ?? NO_FILTER
    return {
      queryKey: api.keys.list(current),
      enabled: current.projectId.length > 0,
      page: (cursor) => api.client.listTasks({ ...current, cursor: cursor ?? null }),
    }
  })
}

export function useTaskDetail(taskId: Accessor<string | undefined>) {
  const api = useTasksApi()
  return useQuery<TaskDetailResponse | null>(() => {
    const id = taskId() ?? ""
    return { queryKey: api.keys.detail(id), enabled: id.length > 0, queryFn: () => api.client.getTask(id) }
  })
}

export function useTaskChildren(taskId: Accessor<string | undefined>): PagedList<TaskSummary> {
  const api = useTasksApi()
  const list = pagedList<TaskSummary>(() => {
    const id = taskId() ?? ""
    return {
      queryKey: api.keys.children(id),
      enabled: id.length > 0,
      page: (cursor) => api.client.listChildren(id, { cursor: cursor ?? null }),
    }
  })
  followEveryPage(list)
  return list
}

export function useTasksInvalidation() {
  const api = useTasksApi()
  const queryClient = useQueryClient()
  const everything = () => queryClient.invalidateQueries({ queryKey: api.keys.scope })
  return {
    everything,
    afterCommand: async (taskId: string) => {
      void queryClient.invalidateQueries({ queryKey: api.keys.detail(taskId) })
      void queryClient.invalidateQueries({ queryKey: api.keys.children(taskId) })
      await everything()
    },
  }
}
