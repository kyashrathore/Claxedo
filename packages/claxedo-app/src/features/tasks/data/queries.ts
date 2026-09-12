import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createMemo, type Accessor } from "solid-js"
import type { Preset, Task, TaskSummary, TasksCapabilities, TaskSessionLinkView } from "@claxedo/tasks"
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

export function usePresetList(scope: Accessor<TasksScope>, includeArchived: Accessor<boolean>) {
  const client = useTasksClient()
  return useQuery<readonly Preset[]>(() => ({
    queryKey: tasksQueryKeys(scope()).presets(includeArchived()),
    queryFn: () => client().listPresets({ includeArchived: includeArchived() }).then((page) => page.items),
  }))
}

export function useTaskList(scope: Accessor<TasksScope>, filter: Accessor<TaskListFilter | undefined>) {
  const client = useTasksClient()
  return useQuery<readonly TaskSummary[]>(() => {
    const current = filter()
    return {
      queryKey: tasksQueryKeys(scope()).list(current ?? { projectId: "", status: null, parent: "any", includeArchived: false }),
      enabled: !!current?.projectId,
      queryFn: () => client().listTasks(current!).then((page) => page.items),
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

export function useTaskChildren(scope: Accessor<TasksScope>, taskId: Accessor<string | undefined>) {
  const client = useTasksClient()
  return useQuery<readonly TaskSummary[]>(() => {
    const id = taskId()
    return {
      queryKey: tasksQueryKeys(scope()).children(id ?? ""),
      enabled: !!id,
      queryFn: () => client().listChildren(id!).then((page) => page.items),
    }
  })
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
