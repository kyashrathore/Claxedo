import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import {
  TASKS_BOUNDS,
  TASKS_ROUTE_PATH,
  taskSummaryOf,
  type Preset,
  type SessionReference,
  type Task,
  type TaskSummary,
} from "@claxedo/tasks"
import { presetRow, taskRow } from "@claxedo/tasks/test-support"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import type { TasksPage } from "@/platform/identity/route"
import { configureTasksAppPorts } from "@/features/tasks/app-ports"
import type { TasksScope } from "@/features/tasks/data/queries"
import { createTasksStore } from "@/features/tasks/store/tasks-store"
import { PresetsView } from "@/features/tasks/ui/presets/presets-view"
import { TasksView } from "@/features/tasks/ui/tasks-view"

vi.mock("@opencode-ai/ui/dropdown-menu", async () => (await import("./shared/test-support/host-controls")).dropdownMenuDouble())
vi.mock("@opencode-ai/ui/select", async () => (await import("./shared/test-support/host-controls")).selectDouble())

afterEach(cleanup)

const SERVER = "http://tasks.test"
const SCOPE: TasksScope = { serverUrl: SERVER, scopeId: "local" }

const task: Task = taskRow({ id: "tsk_1", revision: 4, title: "Ship the importer", status: "doing", updatedAt: 2 })

const preset: Preset = presetRow({
  id: "pre_1",
  revision: 3,
  name: "Careful reviewer",
  instructions: "Read before writing.",
  updatedAt: 2,
})

const summary: TaskSummary = taskSummaryOf(task, { count: 0 }, { total: 0, done: 0 })

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

/**
 * A host that refuses the preset read until it is repaired. The refusal comes
 * back through the real client and decoders, so what the surfaces receive is a
 * read that did not happen rather than a list that came back empty.
 */
function refusedPresetHost() {
  const requested: string[] = []
  let repaired = false
  configureTasksAppPorts({
    useScope: () => () => SCOPE,
    request: async (url) => {
      const path = url.slice(`${SERVER}${TASKS_ROUTE_PATH}`.length)
      requested.push(path)
      if (path.startsWith("/presets")) {
        return repaired
          ? json({ items: [preset], nextCursor: null })
          : json({ error: { code: "forbidden", message: "Presets are not readable here." } }, 403)
      }
      if (path.startsWith("/tasks?")) return json({ items: [summary], nextCursor: null })
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
    useOpenPresetSettings: () => () => {},
    usePaneCtx: () => undefined,
  })
  return {
    requested,
    repair: () => {
      repaired = true
    },
  }
}

function provide(view: () => JSX.Element) {
  render(() => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DialogProvider>{view()}</DialogProvider>
    </QueryClientProvider>
  ))
}

describe("a refused preset read", () => {
  test("a row's Start reports the refusal and offers nothing to start until a retry succeeds", async () => {
    const host = refusedPresetHost()
    provide(() => (
      <TasksView store={createTasksStore()} scope={() => SCOPE} projectId={() => "prj_1"} onOpenTask={() => {}} />
    ))

    fireEvent.click(await waitFor(() => screen.getByTestId("tasks-list-start-menu-tsk_1")))

    await waitFor(() => expect(screen.getByTestId("tasks-list-presets-retry-tsk_1")).toBeTruthy())
    expect(screen.getByRole("alert").textContent).toBe("Presets are not readable here.")
    // An unread catalog is not an empty one, so the menu must not send the
    // user off to create the preset they may already have.
    expect(screen.queryByText("A preset is required to start, and you have none yet.")).toBeNull()
    expect(screen.queryByTestId("tasks-list-preset-settings-tsk_1")).toBeNull()
    expect(screen.getByTestId<HTMLButtonElement>("tasks-list-start-tsk_1").disabled).toBe(true)
    expect(host.requested.filter((path) => path.startsWith("/presets"))).toHaveLength(1)

    host.repair()
    fireEvent.click(screen.getByTestId("tasks-list-presets-retry-tsk_1"))

    await waitFor(() => expect(screen.getByTestId("tasks-list-start-tsk_1-pre_1-primary")).toBeTruthy())
    expect(screen.getByTestId<HTMLButtonElement>("tasks-list-start-tsk_1").disabled).toBe(false)
    expect(screen.queryByTestId("tasks-list-presets-retry-tsk_1")).toBeNull()
    expect(host.requested.filter((path) => path.startsWith("/presets"))).toHaveLength(2)
  })

  test("the Presets view reports the refusal instead of an empty catalog", async () => {
    const host = refusedPresetHost()
    const store = createTasksStore()
    provide(() => <PresetsView store={store} scope={() => SCOPE} />)

    await waitFor(() => expect(screen.getByTestId("preset-list-retry")).toBeTruthy())
    expect(screen.getByRole("alert").textContent).toBe("Presets are not readable here.")
    expect(screen.queryByText("No presets yet.")).toBeNull()
    expect(host.requested.filter((path) => path.startsWith("/presets"))).toHaveLength(1)

    host.repair()
    fireEvent.click(screen.getByTestId("preset-list-retry"))

    await waitFor(() => expect(screen.getByTestId(`preset-list-row-${preset.id}`)).toBeTruthy())
    expect(screen.queryByTestId("preset-list-retry")).toBeNull()
    expect(host.requested.filter((path) => path.startsWith("/presets"))).toHaveLength(2)
  })
})
