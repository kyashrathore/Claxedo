import type { InfiniteData, QueryClient } from "@tanstack/solid-query"
import { TASKS_ROUTE_PATH, taskSummaryOf, type Page, type SessionRef, type Task, type TaskSummary } from "@claxedo/tasks"
import { createTasksClient, type TasksClient } from "@claxedo/tasks/client"
import { probeAvailability } from "./availability"
import { fetchQuery } from "./fetch-query"
import type { AppError } from "./types"
import { placementId, sessionId, type PlacementId } from "./ids"
import { queryKeys } from "./query-keys"
import type { Transport } from "./transport"
import type { FeatureAvailability, SessionLocation } from "./types"
import type { WorkspaceWakes } from "./workspace-wakes"
import type { Workspaces } from "./workspaces"

export const TASKS_PRESETS_PATH = "/api/claxedo/tasks/presets"

export type TaskListKey = {
  readonly projectId: string
  readonly status: string | null
  readonly parent: "any" | "root"
  readonly includeArchived: boolean
}

export type TasksApi = {
  readonly client: TasksClient
  readonly keys: {
    readonly scope: readonly unknown[]
    readonly capabilities: readonly unknown[]
    readonly presets: (includeArchived: boolean) => readonly unknown[]
    readonly list: (filter: TaskListKey) => readonly unknown[]
    readonly detail: (taskId: string) => readonly unknown[]
    readonly children: (taskId: string) => readonly unknown[]
  }
  readonly command: TasksClient["command"]
  readonly locateSession: (ref: SessionRef) => Promise<Pick<SessionLocation, "placementId" | "sessionId">>
  readonly followRoot: (workspaceId: string, following: (placementId: PlacementId) => void) => Promise<TaskRootRun>
}

export type TaskRootRun = { readonly kind: "running" } | { readonly kind: "notRunning"; readonly error?: AppError }

type ChildPages = InfiniteData<Page<TaskSummary>, string | undefined>

export function taskQueries(transport: Transport) {
  return {
    availability: () =>
      fetchQuery<FeatureAvailability>(queryKeys.tasks(transport.serverUrl), () =>
        probeAvailability(transport, TASKS_PRESETS_PATH),
      ),
  }
}

function withCreatedChild(pages: ChildPages | undefined, task: Task): ChildPages | undefined {
  const first = pages?.pages[0]
  if (!pages || !first || pages.pages.some((page) => page.items.some((item) => item.id === task.id))) return pages
  const summary = taskSummaryOf(task, { count: 0 }, { total: 0, done: 0 })
  return { ...pages, pages: [{ ...first, items: [summary, ...first.items] }, ...pages.pages.slice(1)] }
}

export function createTasksApi(transport: Transport, queryClient: QueryClient, workspaces: Workspaces, wakes: Pick<WorkspaceWakes, "follow" | "runtime">): TasksApi {
  const scope = queryKeys.tasksAll(transport.serverUrl)
  const client = createTasksClient({ baseUrl: TASKS_ROUTE_PATH, request: (path, init) => transport.request(path, init) })
  const keys = {
    scope,
    capabilities: [...scope, "capabilities"],
    presets: (includeArchived: boolean) => [...scope, "presets", includeArchived],
    list: (filter: TaskListKey) => [...scope, "list", filter],
    detail: (taskId: string) => [...scope, "detail", taskId],
    children: (taskId: string) => [...scope, "children", taskId],
  }
  return {
    client,
    keys,
    command: async (request) => {
      const response = await client.command(request)
      const created = response.result.type === "task.create" ? response.result.task : undefined
      if (created?.parentTaskId) {
        queryClient.setQueryData<ChildPages>(keys.children(created.parentTaskId), (pages) => withCreatedChild(pages, created))
      }
      return response
    },
    locateSession: async (ref) => {
      const location = { placementId: placementId(ref.workspaceId), sessionId: sessionId(ref.sessionId) }
      if (!workspaces.byId(location.placementId) && !workspaces.shared.find(location)) await workspaces.refresh()
      return location
    },
    followRoot: async (workspaceId, following) => {
      await workspaces.refresh()
      const id = placementId(workspaceId)
      following(id)
      await wakes.follow(id)
      const runtime = wakes.runtime(id)
      if (runtime.kind === "live") return { kind: "running" }
      return runtime.kind === "wakeFailed" ? { kind: "notRunning", error: runtime.error } : { kind: "notRunning" }
    },
  }
}
