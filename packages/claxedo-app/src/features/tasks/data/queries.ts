import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, type Accessor } from "solid-js"
import type { Page, Preset, Task, TaskSummary, TasksCapabilities, TaskSessionLinkView } from "@claxedo/tasks"
import { useTasksAppPorts, type TasksScope } from "../app-ports"
import { createTasksApi, tasksQueryKeys, type TaskListFilter } from "./tasks-api"

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
 */
export type PagedList<T> = {
  items: Accessor<readonly T[]>
  pending: Accessor<boolean>
  error: Accessor<unknown>
  hasMore: Accessor<boolean>
  loadingMore: Accessor<boolean>
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
    error: () => query.error,
    hasMore: () => query.hasNextPage,
    loadingMore: () => query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
  }
}

function followEveryPage(list: PagedList<unknown>) {
  createEffect(() => {
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
  return {
    everything: () => queryClient.invalidateQueries({ queryKey: tasksQueryKeys(scope()).scope }),
    task: (taskId: string) => {
      void queryClient.invalidateQueries({ queryKey: tasksQueryKeys(scope()).detail(taskId) })
      void queryClient.invalidateQueries({ queryKey: tasksQueryKeys(scope()).children(taskId) })
    },
  }
}
