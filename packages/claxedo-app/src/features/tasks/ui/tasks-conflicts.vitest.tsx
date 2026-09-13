import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import type { JSX } from "solid-js"
import {
  TASKS_BOUNDS,
  TASKS_ROUTE_PATH,
  type Preset,
  type SessionReference,
  type Task,
} from "@claxedo/tasks"
import { presetEditorDraftOf } from "../preset-editor-model"
import { configureTasksAppPorts, type TasksAppPorts } from "@/features/tasks/app-ports"
import type { TasksScope } from "@/features/tasks/data/queries"
import { createTasksStore } from "@/features/tasks/store/tasks-store"
import { PresetDraftEditor } from "@/features/tasks/ui/presets/preset-draft-editor"
import { TaskDetailPanel } from "@/features/tasks/ui/detail/task-detail-panel"

vi.mock("@opencode-ai/ui/dropdown-menu", async () => (await import("./shared/test-support/host-controls")).dropdownMenuDouble())
vi.mock("@opencode-ai/ui/select", async () => (await import("./shared/test-support/host-controls")).selectDouble())

afterEach(cleanup)

const SERVER = "http://tasks.test"
const SCOPE: TasksScope = { serverUrl: SERVER, scopeId: "local" }

const task: Task = {
  id: "tsk_1",
  revision: 4,
  scopeId: "local",
  projectId: "prj_1",
  workspaceId: null,
  number: 1,
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

function staleJson(message: string, record: { currentTask: Task } | { currentPreset: Preset }) {
  return json({ error: { code: "stale_revision", message, ...record } }, 409)
}

const CAPABILITIES = {
  protocolVersion: 1,
  placements: ["local"],
  cloudSelectedCapabilities: false,
  instructions: true,
  configurationSlots: ["primary"],
  bounds: TASKS_BOUNDS,
}

type Body = { command: { type: string; input: Record<string, unknown> } }

function ports(request: TasksAppPorts["request"]): TasksAppPorts {
  return {
    useScope: () => () => SCOPE,
    request,
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
  }
}

function renderWithClient(node: () => JSX.Element) {
  render(() => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DialogProvider>{node()}</DialogProvider>
    </QueryClientProvider>
  ))
}

describe("a refused edit rebases onto the record the host returned", () => {
  test("a stale task edit keeps every typed character and the next save carries the rebased revision", async () => {
    const commands: Body[] = []
    let revision = task.revision
    let title = task.title
    let renameOnFirstEdit = true
    const current = (): Task => ({ ...task, revision, title })

    configureTasksAppPorts(
      ports(async (url, init) => {
        const path = url.slice(`${SERVER}${TASKS_ROUTE_PATH}`.length)
        if (path === `/tasks/${task.id}`) return json({ task: current(), links: [] })
        if (path.startsWith(`/tasks/${task.id}/children`)) return json({ items: [], nextCursor: null })
        if (path.startsWith("/presets")) return json({ items: [], nextCursor: null })
        if (path === "/commands") {
          const body = JSON.parse(String(init?.body)) as Body
          commands.push(body)
          if (renameOnFirstEdit) {
            // Another client saved between this panel's read and this save.
            renameOnFirstEdit = false
            revision += 1
            title = "Renamed elsewhere"
            return staleJson(`Task ${task.id} is at revision ${revision}`, { currentTask: current() })
          }
          if (body.command.input.revision !== revision) {
            return staleJson(`Task ${task.id} is at revision ${revision}`, { currentTask: current() })
          }
          revision += 1
          title = String(body.command.input.title)
          return json({ result: { type: "task.edit", task: current(), parent: null }, replayed: false })
        }
        throw new Error(`unexpected request ${path}`)
      }),
    )

    const store = createTasksStore()
    renderWithClient(() => (
      <TaskDetailPanel store={store} scope={() => SCOPE} taskId={task.id} onOpenTask={() => {}} onBack={() => {}} />
    ))

    const titleField = await waitFor(() => screen.getByTestId("task-detail-title"))
    await waitFor(() => expect(titleField.value).toBe("Ship the importer"))
    fireEvent.input(titleField, { target: { value: "My local title" } })
    fireEvent.click(await waitFor(() => screen.getByTestId("task-detail-save")))

    await waitFor(() => expect(screen.getByTestId("task-detail-conflict").textContent).toContain("Renamed elsewhere"))
    expect(commands[0]?.command.input.revision).toBe(4)
    expect(titleField.value).toBe("My local title")

    fireEvent.click(screen.getByTestId("task-detail-save"))

    await waitFor(() => expect(commands).toHaveLength(2))
    expect(commands[1]?.command.input.revision).toBe(5)
    expect(commands[1]?.command.input.title).toBe("My local title")
    await waitFor(() => expect(screen.queryByTestId("task-detail-conflict")).toBeNull())
    await waitFor(() => expect(screen.getByTestId("task-detail-title").value).toBe("My local title"))
  })

  test("a stale preset edit keeps the draft and the next save carries the rebased revision", async () => {
    const commands: Body[] = []
    let revision = preset.revision
    let name = preset.name
    let renameOnFirstEdit = true
    const current = (): Preset => ({ ...preset, revision, name })

    configureTasksAppPorts(
      ports(async (url, init) => {
        const path = url.slice(`${SERVER}${TASKS_ROUTE_PATH}`.length)
        if (path === "/capabilities") return json(CAPABILITIES)
        if (path.startsWith("/presets")) return json({ items: [current()], nextCursor: null })
        if (path === "/commands") {
          const body = JSON.parse(String(init?.body)) as Body
          commands.push(body)
          if (renameOnFirstEdit) {
            renameOnFirstEdit = false
            revision += 1
            name = "Renamed elsewhere"
            return staleJson(`Preset ${preset.id} is at revision ${revision}`, { currentPreset: current() })
          }
          if (body.command.input.revision !== revision) {
            return staleJson(`Preset ${preset.id} is at revision ${revision}`, { currentPreset: current() })
          }
          revision += 1
          name = String(body.command.input.name)
          return json({ result: { type: "preset.edit", preset: current() }, replayed: false })
        }
        throw new Error(`unexpected request ${path}`)
      }),
    )

    const store = createTasksStore()
    store.openPresetDraft(presetEditorDraftOf(preset), preset)
    renderWithClient(() => <PresetDraftEditor store={store} scope={() => SCOPE} />)

    const nameField = await waitFor(() => screen.getByTestId("preset-editor-name"))
    expect(nameField.value).toBe("Careful reviewer")
    fireEvent.input(nameField, { target: { value: "My preset name" } })
    fireEvent.click(screen.getByTestId("preset-editor-submit"))

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("is at revision 4"))
    expect(commands[0]?.command.input.revision).toBe(3)
    expect(nameField.value).toBe("My preset name")

    fireEvent.click(screen.getByTestId("preset-editor-submit"))

    await waitFor(() => expect(commands).toHaveLength(2))
    expect(commands[1]?.command.input.revision).toBe(4)
    expect(commands[1]?.command.input.name).toBe("My preset name")
    await waitFor(() => expect(screen.queryByTestId("preset-editor")).toBeNull())
  })
})
