import { TASKS_ROUTE_PATH } from "@claxedo/tasks"
import { createTasksClient } from "@claxedo/tasks/client"
import type { TasksApi, TaskListKey } from "./api"
import { probeAvailability } from "./availability"
import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import type { Transport } from "./transport"
import type { FeatureAvailability } from "./types"

export const TASKS_PRESETS_PATH = "/api/claxedo/tasks/presets"

export function taskQueries(transport: Transport) {
  return {
    availability: () =>
      fetchQuery<FeatureAvailability>(queryKeys.tasks(transport.serverUrl), () =>
        probeAvailability(transport, TASKS_PRESETS_PATH),
      ),
  }
}

export function createTasksApi(transport: Transport): TasksApi {
  const scope = queryKeys.tasksAll(transport.serverUrl)
  return {
    client: createTasksClient({ baseUrl: TASKS_ROUTE_PATH, request: (path, init) => transport.request(path, init) }),
    keys: {
      scope,
      capabilities: [...scope, "capabilities"],
      presets: (includeArchived: boolean) => [...scope, "presets", includeArchived],
      list: (filter: TaskListKey) => [...scope, "list", filter],
      detail: (taskId: string) => [...scope, "detail", taskId],
      children: (taskId: string) => [...scope, "children", taskId],
    },
  }
}
