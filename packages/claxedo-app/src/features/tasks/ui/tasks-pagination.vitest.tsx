import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { TASKS_ROUTE_PATH, type SessionReference, type Task, type TaskSummary } from "@claxedo/tasks"
import { configureTasksAppPorts } from "@/features/tasks/app-ports"
import { createTasksStore } from "@/features/tasks/store/tasks-store"
import { TasksView } from "@/features/tasks/ui/tasks-view"

afterEach(cleanup)

const SERVER = "http://tasks.test"

function summary(id: string, overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id,
    revision: 1,
    scopeId: "local",
    projectId: "prj_1",
    workspaceId: null,
    parentTaskId: null,
    title: `Task ${id}`,
    status: "todo",
    childSetRevision: 0,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    hasDescription: false,
    ...overrides,
  }
}

const parent: Task = {
  id: "tsk_1",
  revision: 1,
  scopeId: "local",
  projectId: "prj_1",
  workspaceId: null,
  parentTaskId: null,
  title: "Task tsk_1",
  description: "",
  status: "doing",
  childSetRevision: 2,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
}

/**
 * Two pages per list, each reachable only through the cursor the previous page
 * returned, so a discarded cursor leaves the second page unreachable.
 */
function mount() {
  const requested: string[] = []
  configureTasksAppPorts({
    useScope: () => () => ({ serverUrl: SERVER, scopeId: "local" }),
    request: async (url) => {
      const path = url.slice(`${SERVER}${TASKS_ROUTE_PATH}`.length)
      requested.push(path)
      const cursor = new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("cursor")
      if (path.startsWith("/tasks?")) {
        return cursor === "tasks-page-2"
          ? json({ items: [summary("tsk_2")], nextCursor: null })
          : json({ items: [summary("tsk_1", { status: "doing" })], nextCursor: "tasks-page-2" })
      }
      if (path.startsWith("/tasks/tsk_1/children")) {
        return cursor === "children-page-2"
          ? json({ items: [summary("tsk_c2", { parentTaskId: "tsk_1" })], nextCursor: null })
          : json({ items: [summary("tsk_c1", { parentTaskId: "tsk_1" })], nextCursor: "children-page-2" })
      }
      if (path === "/tasks/tsk_1") return json({ task: parent, links: [] })
      throw new Error(`unexpected request ${path}`)
    },
    useProjects: () => () => [{ id: "prj_1", label: "Importer" }],
    useActiveProjectId: () => () => "prj_1",
    useCapabilityCatalog: () => () => ({ plugins: [], skills: [], loading: false }),
    ConfigurationEditor: () => null,
    useOpenSession: () => vi.fn<(session: SessionReference) => void>(),
  })

  const store = createTasksStore()
  store.selectTask("tsk_1")
  render(() => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DialogProvider>
        <TasksView store={store} scope={() => ({ serverUrl: SERVER, scopeId: "local" })} projectId={() => "prj_1"} />
      </DialogProvider>
    </QueryClientProvider>
  ))
  return { store, requested }
}

describe("tasks pagination", () => {
  test("Load more appends the next page in the list and on the board", async () => {
    mount()

    await waitFor(() => expect(screen.getByTestId("tasks-list-row-tsk_1")).toBeTruthy())
    expect(screen.queryByTestId("tasks-list-row-tsk_2")).toBeNull()

    fireEvent.click(screen.getByTestId("tasks-view-toggle"))
    fireEvent.click(await waitFor(() => screen.getByTestId("tasks-board-load-more")))

    await waitFor(() => expect(screen.getByTestId("tasks-board-card-tsk_2")).toBeTruthy())
    expect(screen.getByTestId("tasks-board-card-tsk_1")).toBeTruthy()
    expect(screen.queryByTestId("tasks-board-load-more")).toBeNull()

    fireEvent.click(screen.getByTestId("tasks-view-toggle"))
    await waitFor(() => expect(screen.getByTestId("tasks-list-row-tsk_2")).toBeTruthy())
    expect(screen.queryByTestId("tasks-list-load-more")).toBeNull()
  })

  test("the children region shows every page, so the parent's Done guard counts what it shows", async () => {
    mount()

    await waitFor(() => expect(screen.getByTestId("task-subtask-tsk_c1")).toBeTruthy())
    await waitFor(() => expect(screen.getByTestId("task-subtask-tsk_c2")).toBeTruthy())
  })

  test("the first list page is fetched without a cursor and Load more carries the server's", async () => {
    const { requested } = mount()

    await waitFor(() => expect(screen.getByTestId("tasks-list-load-more")).toBeTruthy())
    expect(requested.filter((path) => path.startsWith("/tasks?")).at(0)).not.toContain("cursor=")

    fireEvent.click(screen.getByTestId("tasks-list-load-more"))

    await waitFor(() =>
      expect(requested.filter((path) => path.startsWith("/tasks?") && path.includes("cursor=tasks-page-2"))).toHaveLength(1),
    )
  })
})
