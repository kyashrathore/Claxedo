import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import { TASKS_BOUNDS, TASKS_ROUTE_PATH, type Preset, type SessionReference, type Task } from "@claxedo/tasks"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { configureTasksAppPorts } from "@/features/tasks/app-ports"
import type { TasksScope } from "@/features/tasks/data/queries"
import { createTasksStore } from "@/features/tasks/store/tasks-store"
import { PresetsView } from "@/features/tasks/ui/presets-view"
import { StartTaskFlow } from "@/features/tasks/ui/start-task-flow"

afterEach(cleanup)

const SERVER = "http://tasks.test"
const SCOPE: TasksScope = { serverUrl: SERVER, scopeId: "local" }

const task: Task = {
  id: "tsk_1",
  revision: 4,
  scopeId: "local",
  projectId: "prj_1",
  workspaceId: null,
  parentTaskId: null,
  title: "Ship the importer",
  description: "",
  status: "doing",
  childSetRevision: 0,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 2,
}

const preset: Preset = {
  id: "pre_1",
  revision: 3,
  scopeId: "local",
  ownerId: "local",
  name: "Careful reviewer",
  instructions: "Read before writing.",
  execution: { placement: "local", capabilities: { mode: "inherit-local" } },
  configurations: {
    primary: { harness: { id: "claude", access: "native" }, model: { providerID: "anthropic", modelID: "sonnet" }, effort: null },
  },
  archivedAt: null,
  createdAt: 1,
  updatedAt: 2,
}

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
      if (path === "/capabilities") {
        return json({
          protocolVersion: 1,
          placements: ["local"],
          cloudSelectedCapabilities: false,
          instructions: true,
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
    useOpenSession: () => vi.fn<(session: SessionReference) => void>(),
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
      {view()}
    </QueryClientProvider>
  ))
}

describe("a refused preset read", () => {
  test("Start reports the refusal and offers nothing to start until a retry succeeds", async () => {
    const host = refusedPresetHost()
    provide(() => (
      <StartTaskFlow
        store={createTasksStore()}
        scope={() => SCOPE}
        task={task}
        slot="primary"
        attempt={2}
        onClose={() => {}}
      />
    ))

    await waitFor(() => expect(screen.getByTestId("start-task-presets-retry")).toBeTruthy())
    expect(screen.getByRole("alert").textContent).toBe("Presets are not readable here.")
    expect(screen.queryByTestId("start-task-no-presets")).toBeNull()
    expect(screen.queryByTestId("start-task-create-preset")).toBeNull()
    expect(screen.getByTestId<HTMLButtonElement>("start-task-submit").disabled).toBe(true)
    expect(host.requested.filter((path) => path.startsWith("/presets"))).toHaveLength(1)

    host.repair()
    fireEvent.click(screen.getByTestId("start-task-presets-retry"))

    await waitFor(() => expect(screen.getByTestId("start-task-preset")).toBeTruthy())
    expect(screen.getByRole("option", { name: preset.name })).toBeTruthy()
    expect(screen.queryByTestId("start-task-presets-retry")).toBeNull()
    expect(host.requested.filter((path) => path.startsWith("/presets"))).toHaveLength(2)
  })

  test("the Presets view reports the refusal instead of an empty catalog", async () => {
    const host = refusedPresetHost()
    provide(() => <PresetsView store={createTasksStore()} scope={() => SCOPE} />)

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
