import type { ServerApi } from "@claxedo/plugin-api"
import { createTasksClient, type TasksClient } from "../client/client"
import { TASKS_ROUTE_PATH } from "../contracts"

export function tasksClientOf(server: ServerApi): TasksClient {
  return createTasksClient({ baseUrl: TASKS_ROUTE_PATH, request: (path, init) => server.fetch(path, init) })
}
