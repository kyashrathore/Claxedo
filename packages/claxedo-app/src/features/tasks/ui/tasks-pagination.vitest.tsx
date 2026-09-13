import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { TASKS_BOUNDS, TASKS_ROUTE_PATH, type Preset, type SessionReference, type Task, type TaskSummary } from "@claxedo/tasks"
import type { TasksPage } from "@/platform/identity/route"
import { configureTasksAppPorts } from "@/features/tasks/app-ports"
import { createTasksStore } from "@/features/tasks/store/tasks-store"
import { PresetsView } from "@/features/tasks/ui/presets/presets-view"
import { TaskDetailPage } from "@/features/tasks/ui/detail/task-detail-page"
import { TasksView } from "@/features/tasks/ui/tasks-view"

vi.mock("@opencode-ai/ui/dropdown-menu", async () => (await import("./shared/test-support/host-controls")).dropdownMenuDouble())
vi.mock("@opencode-ai/ui/select", async () => (await import("./shared/test-support/host-controls")).selectDouble())

afterEach(cleanup)

const SERVER = "http://tasks.test"

function summary(id: string, overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id,
    revision: 1,
    scopeId: "local",
    projectId: "prj_1",
    workspaceId: null,
    number: 1,
    parentTaskId: null,
    title: `Task ${id}`,
    status: "todo",
    childSetRevision: 0,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    hasDescription: false,
    links: { count: 0 },
    children: { total: 0, done: 0 },
    ...overrides,
  }
}

const parent: Task = {
  id: "tsk_1",
  revision: 1,
  scopeId: "local",
  projectId: "prj_1",
  workspaceId: null,
  number: 1,
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
function configureHost() {
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
    ProseEditor: (props: { value: string; testId: string; ariaLabel: string; placeholder: string; onChange: (value: string) => void }) => (
      <textarea
        data-testid={props.testId}
        aria-label={props.ariaLabel}
        placeholder={props.placeholder}
        value={props.value}
        onInput={(event) => props.onChange(event.currentTarget.value)}
      />
    ),
    useOpenSession: () => vi.fn<(session: SessionReference) => void>(),
    useOpenPage: () => vi.fn<(page?: TasksPage) => void>(),
    openPresetSettings: () => {},
  })

  return requested
}

function provideWithHost(view: (store: ReturnType<typeof createTasksStore>) => JSX.Element) {
  const requested = configureHost()
  const store = createTasksStore()
  provide(() => view(store))
  return { store, requested }
}

function mount() {
  return provideWithHost((store) => (
    <TasksView
      store={store}
      scope={() => ({ serverUrl: SERVER, scopeId: "local" })}
      projectId={() => "prj_1"}
      onOpenTask={() => {}}
    />
  ))
}

/** `/tasks/tsk_1`: subtasks live on the task's own page, not under the list. */
function mountTaskPage() {
  return provideWithHost((store) => (
    <TaskDetailPage
      store={store}
      scope={() => ({ serverUrl: SERVER, scopeId: "local" })}
      taskId="tsk_1"
      onOpenTask={() => {}}
      onBack={() => {}}
    />
  ))
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
    mountTaskPage()

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

function presetRow(id: string): Preset {
  return {
    id,
    revision: 1,
    scopeId: "local",
    ownerId: "local",
    name: `Preset ${id}`,
    instructions: "",
    execution: { placement: "local", capabilities: { mode: "inherit-local" } },
    configurations: {
      primary: { harness: { id: "claude", access: "native" }, model: { providerID: "anthropic", modelID: "sonnet" }, effort: null },
    },
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

/**
 * A host that refuses the second page of every followed list until it is
 * repaired. Its answers resolve on a timer rather than a microtask, so a
 * follow that never stops cannot starve the settle window below.
 */
function failingSecondPageHost() {
  const requested: string[] = []
  let repaired = false
  configureTasksAppPorts({
    useScope: () => () => ({ serverUrl: SERVER, scopeId: "local" }),
    request: async (url) => {
      const path = url.slice(`${SERVER}${TASKS_ROUTE_PATH}`.length)
      requested.push(path)
      await new Promise((resolve) => setTimeout(resolve, 0))
      const cursor = new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("cursor")
      if (path.startsWith("/presets")) {
        if (cursor !== "presets-page-2") return json({ items: [presetRow("pre_1")], nextCursor: "presets-page-2" })
        return repaired ? json({ items: [presetRow("pre_2")], nextCursor: null }) : nextPageRefusal()
      }
      if (path.startsWith("/tasks/tsk_1/children")) {
        if (cursor !== "children-page-2") {
          return json({ items: [summary("tsk_c1", { parentTaskId: "tsk_1" })], nextCursor: "children-page-2" })
        }
        return repaired ? json({ items: [summary("tsk_c2", { parentTaskId: "tsk_1" })], nextCursor: null }) : nextPageRefusal()
      }
      if (path.startsWith("/tasks?")) return json({ items: [summary("tsk_1", { status: "doing" })], nextCursor: null })
      if (path === "/tasks/tsk_1") return json({ task: parent, links: [] })
      if (path === "/capabilities") {
        return json({
          protocolVersion: 1,
          placements: ["local"],
          cloudSelectedCapabilities: false,
          configurationSlots: ["primary"],
          bounds: TASKS_BOUNDS,
        })
      }
      throw new Error(`unexpected request ${path}`)
    },
    useProjects: () => () => [{ id: "prj_1", label: "Importer" }],
    useActiveProjectId: () => () => "prj_1",
    useCapabilityCatalog: () => () => ({ plugins: [], skills: [], loading: false }),
    ConfigurationEditor: () => null,
    ProseEditor: (props: { value: string; testId: string; ariaLabel: string; placeholder: string; onChange: (value: string) => void }) => (
      <textarea
        data-testid={props.testId}
        aria-label={props.ariaLabel}
        placeholder={props.placeholder}
        value={props.value}
        onInput={(event) => props.onChange(event.currentTarget.value)}
      />
    ),
    useOpenSession: () => vi.fn<(session: SessionReference) => void>(),
    useOpenPage: () => vi.fn<(page?: TasksPage) => void>(),
    openPresetSettings: () => {},
  })
  return {
    requested,
    repair: () => {
      repaired = true
    },
  }
}

function nextPageRefusal() {
  return new Response(JSON.stringify({ error: { code: "conflict", message: "The next page is unavailable." } }), {
    status: 409,
    headers: { "Content-Type": "application/json" },
  })
}

function provide(view: () => JSX.Element) {
  render(() => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DialogProvider>{view()}</DialogProvider>
    </QueryClientProvider>
  ))
}

/** Long enough for an unbounded follow to issue many more requests than the assertions allow. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 50))
}

describe("a followed list whose next page fails", () => {
  test("children stop following, and one Retry finishes what the failure interrupted", async () => {
    const host = failingSecondPageHost()
    provide(() => (
      <TaskDetailPage
        store={createTasksStore()}
        scope={() => ({ serverUrl: SERVER, scopeId: "local" })}
        taskId="tsk_1"
        onOpenTask={() => {}}
        onBack={() => {}}
      />
    ))

    await waitFor(() => expect(screen.getByTestId("task-subtask-tsk_c1")).toBeTruthy())
    await waitFor(() => expect(screen.getByTestId("task-subtasks-load-more").textContent).toBe("Retry"))
    await settle()
    expect(host.requested.filter((path) => path.startsWith("/tasks/tsk_1/children"))).toHaveLength(2)

    host.repair()
    fireEvent.click(screen.getByTestId("task-subtasks-load-more"))

    await waitFor(() => expect(screen.getByTestId("task-subtask-tsk_c2")).toBeTruthy())
    await settle()
    expect(host.requested.filter((path) => path.startsWith("/tasks/tsk_1/children"))).toHaveLength(3)
    expect(screen.queryByTestId("task-subtasks-load-more")).toBeNull()
  })

  test("presets stop following, and the refusal is readable where the list is", async () => {
    const host = failingSecondPageHost()
    const store = createTasksStore()
    provide(() => <PresetsView store={store} scope={() => ({ serverUrl: SERVER, scopeId: "local" })} />)

    await waitFor(() => expect(screen.getByTestId("preset-list-row-pre_1")).toBeTruthy())
    await waitFor(() => expect(screen.getByTestId("preset-list-load-more").textContent).toBe("Retry"))
    expect(screen.getByRole("alert").textContent).toBe("The next page is unavailable.")
    await settle()
    expect(host.requested.filter((path) => path.startsWith("/presets"))).toHaveLength(2)

    host.repair()
    fireEvent.click(screen.getByTestId("preset-list-load-more"))

    await waitFor(() => expect(screen.getByTestId("preset-list-row-pre_2")).toBeTruthy())
    await settle()
    expect(host.requested.filter((path) => path.startsWith("/presets"))).toHaveLength(3)
    expect(screen.queryByTestId("preset-list-load-more")).toBeNull()
  })
})
