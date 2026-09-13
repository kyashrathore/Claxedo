import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import {
  TASKS_ROUTE_PATH,
  type Preset,
  type SessionReference,
  type Task,
  type TaskSummary,
} from "@claxedo/tasks"
import type { TasksPage } from "@/platform/identity/route"
import { configureTasksAppPorts } from "@/features/tasks/app-ports"
import { TasksSurface } from "@/features/tasks/ui/tasks-surface"

afterEach(cleanup)

const SERVER = "http://tasks.test"

const preset: Preset = {
  id: "pre_1",
  revision: 2,
  scopeId: "local",
  ownerId: "owner",
  name: "Careful reviewer",
  instructions: "",
  execution: { placement: "local", capabilities: { mode: "inherit-local" } },
  configurations: {
    primary: {
      harness: { id: "claude", access: "native" },
      model: { providerID: "anthropic", modelID: "opus" },
      effort: null,
    },
  },
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
}

const task: Task = {
  id: "tsk_1",
  revision: 4,
  scopeId: "local",
  projectId: "prj_1",
  workspaceId: null,
  parentTaskId: null,
  title: "Ship the importer",
  description: "",
  status: "todo",
  childSetRevision: 0,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
}

const summary: TaskSummary = {
  ...(({ description: _description, ...rest }) => rest)(task),
  hasDescription: false,
  links: { count: 1 },
  children: { total: 0, done: 0 },
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
}

/**
 * The whole surface, so a navigation is proved by what ends up on screen
 * rather than by a callback having been called.
 */
function mount(input: { links?: unknown[]; presets?: Preset[] } = {}) {
  const [page, setPage] = createSignal<TasksPage | undefined>()
  const openSession = vi.fn<(session: SessionReference) => void>()
  const requested: { path: string; body?: unknown }[] = []

  configureTasksAppPorts({
    useScope: () => () => ({ serverUrl: SERVER, scopeId: "local" }),
    request: async (url, init) => {
      const path = url.slice(`${SERVER}${TASKS_ROUTE_PATH}`.length)
      requested.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (path.startsWith("/tasks?")) return json({ items: [summary], nextCursor: null })
      if (path.startsWith("/presets")) return json({ items: input.presets ?? [preset], nextCursor: null })
      if (path === "/tasks/tsk_1") return json({ task, links: input.links ?? [] })
      if (path.startsWith("/tasks/tsk_1/children")) return json({ items: [], nextCursor: null })
      if (path.startsWith("/tasks/tsk_1/start-preview")) {
        return json({ preview: { digest: "d".repeat(64), expiresAt: 0, placement: "local", slot: "primary", attempt: 9, configuration: preset.configurations.primary, capabilities: { mode: "inherit-local" }, available: true, blockers: [], currentSession: null, previousTranscriptReadable: false, destinationDescription: "here" } })
      }
      if (path === "/tasks/tsk_1/start") {
        return json({ link: { taskId: "tsk_1", slot: "primary", attempt: 2, sessionRef: { sessionId: "ses_2", workspaceId: null }, continuedFrom: null, presetId: "pre_1", presetRevision: 2, presetNameAtStart: "Careful reviewer", createdAt: 1, liveness: "live", handoff: "sent" }, replayed: false })
      }
      throw new Error(`unexpected request ${path}`)
    },
    useProjects: () => () => [{ id: "prj_1", label: "Importer" }],
    useActiveProjectId: () => () => "prj_1",
    useCapabilityCatalog: () => () => ({ plugins: [], skills: [], loading: false }),
    ConfigurationEditor: () => null,
    ProseEditor: (props: { value: string; testId: string; ariaLabel: string; placeholder: string; onChange: (value: string) => void }) => (
      <textarea data-testid={props.testId} aria-label={props.ariaLabel} value={props.value} onInput={(event) => props.onChange(event.currentTarget.value)} />
    ),
    useOpenSession: () => openSession,
    useOpenPage: () => (next?: TasksPage) => setPage(() => next),
  })

  render(() => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DialogProvider>
        <TasksSurface page={page} />
      </DialogProvider>
    </QueryClientProvider>
  ))
  return { openSession, requested, page }
}

const link = (liveness: "live" | "deleted") => ({
  taskId: "tsk_1",
  slot: "primary",
  attempt: 1,
  sessionRef: { sessionId: "ses_1", workspaceId: null },
  continuedFrom: null,
  presetId: "pre_1",
  presetRevision: 2,
  presetNameAtStart: "Careful reviewer",
  createdAt: 1,
  liveness,
  handoff: liveness === "live" ? "sent" : "unknown",
})

describe("starting and opening from a list row", () => {
  // The editor renders on the Presets page, so opening a draft without going
  // there left the user on the list with nothing on screen.
  test("Create a preset from a row's menu lands on the preset editor", async () => {
    mount({ presets: [] })

    fireEvent.click(await waitFor(() => screen.getByTestId("tasks-list-start-menu-tsk_1")))
    fireEvent.click(screen.getByTestId("tasks-list-create-preset-tsk_1"))

    await waitFor(() => expect(screen.getByTestId("preset-editor")).toBeTruthy())
    expect(screen.queryByTestId("tasks-list")).toBeNull()
  })

  /**
   * The service accepts the slot's current attempt only while its session is
   * live, and `current + 1` once it is gone. A row that always previewed 1 was
   * refused by every slot that had already run.
   */
  test("Start on a slot whose session is gone previews the next attempt, not the first", async () => {
    const { requested } = mount({ links: [link("deleted")] })

    // A slot that has run shows Open on the main part, so starting again is
    // the caret's job.
    fireEvent.click(await waitFor(() => screen.getByTestId("tasks-list-start-menu-tsk_1")))
    fireEvent.click(screen.getByTestId("tasks-list-start-tsk_1-pre_1-primary"))

    const preview = await waitFor(() => {
      const found = requested.find((entry) => entry.path.startsWith("/tasks/tsk_1/start-preview"))
      if (!found) throw new Error("no preview was requested")
      return found
    })
    expect((preview.body as { attempt: number }).attempt).toBe(2)
  })

  test("Open does not navigate to a session the host says is gone", async () => {
    const { openSession } = mount({ links: [link("deleted")] })

    fireEvent.click(await waitFor(() => screen.getByTestId("tasks-list-open-session-tsk_1")))

    await waitFor(() => expect(screen.getByTestId("tasks-list-start-menu-tsk_1")).toBeTruthy())
    fireEvent.click(screen.getByTestId("tasks-list-start-menu-tsk_1"))
    await waitFor(() => expect(screen.getByTestId("tasks-list-start-blocker-tsk_1").textContent).toContain("deleted"))
    expect(openSession).not.toHaveBeenCalled()
  })

  test("Open navigates while the host still reports the session live", async () => {
    const { openSession } = mount({ links: [link("live")] })

    fireEvent.click(await waitFor(() => screen.getByTestId("tasks-list-open-session-tsk_1")))

    await waitFor(() => expect(openSession).toHaveBeenCalledWith({ sessionId: "ses_1", workspaceId: null }))
  })
})
