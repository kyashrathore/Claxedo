import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import {
  TASKS_ROUTE_PATH,
  linkView,
  taskSummaryOf,
  type ConfigurationSlot,
  type Preset,
  type SessionLiveness,
  type SessionReference,
  type Task,
  type TaskSummary,
} from "@claxedo/tasks"
import { linkRow, presetRow, taskRow } from "@claxedo/tasks/test-support"
import type { TasksPage } from "@/platform/identity/route"
import { configureTasksAppPorts } from "@/features/tasks/app-ports"
import { TasksSurface } from "@/features/tasks/ui/tasks-surface"

vi.mock("@opencode-ai/ui/dropdown-menu", async () => (await import("./test-support/host-controls")).dropdownMenuDouble())
vi.mock("@opencode-ai/ui/select", async () => (await import("./test-support/host-controls")).selectDouble())

afterEach(cleanup)

const SERVER = "http://tasks.test"

const preset: Preset = presetRow({ id: "pre_1", revision: 2, name: "Careful reviewer" })

const task: Task = taskRow({ id: "tsk_1", revision: 4, title: "Ship the importer" })

const summary: TaskSummary = taskSummaryOf(task, { count: 1 }, { total: 0, done: 0 })

const PREVIEW_DIGEST = "d".repeat(64)
const STARTED_SESSION = { sessionId: "ses_2", workspaceId: null }

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
}

/**
 * The whole surface, so a navigation is proved by what ends up on screen
 * rather than by a callback having been called.
 */
function mount(input: { links?: unknown[]; presets?: Preset[]; transcriptReadable?: boolean } = {}) {
  const [page, setPage] = createSignal<TasksPage | undefined>()
  const openSession = vi.fn<(session: SessionReference) => void>()
  const openPresetSettings = vi.fn()
  const requested: { path: string; body?: unknown }[] = []

  configureTasksAppPorts({
    useScope: () => () => ({ serverUrl: SERVER, scopeId: "local" }),
    request: async (url, init) => {
      const path = url.slice(`${SERVER}${TASKS_ROUTE_PATH}`.length)
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      requested.push({ path, body })
      if (path.startsWith("/tasks?")) return json({ items: [summary], nextCursor: null })
      if (path.startsWith("/presets")) return json({ items: input.presets ?? [preset], nextCursor: null })
      if (path === "/tasks/tsk_1") return json({ task, links: input.links ?? [], attachments: [] })
      if (path.startsWith("/tasks/tsk_1/children")) return json({ items: [], nextCursor: null })
      // The service resolves a preview against the slot and attempt it was
      // asked for and mints a digest bound to them, then admits a start only
      // for that pair; a fake that answers a different attempt lets a caller
      // that never sends the digest, or sends it with another attempt, pass.
      const sent = body as { slot: ConfigurationSlot; attempt: number; continueFromPrevious?: boolean } | undefined
      if (path.startsWith("/tasks/tsk_1/start-preview")) {
        return json({ preview: { digest: PREVIEW_DIGEST, expiresAt: 0, placement: "local", slot: sent?.slot, attempt: sent?.attempt, configuration: preset.configurations.primary, capabilities: { mode: "inherit-local" }, available: true, blockers: [], currentSession: null, previousTranscriptReadable: input.transcriptReadable === true, destinationDescription: "here" } })
      }
      if (path === "/tasks/tsk_1/sessions") {
        return json({ link: { taskId: "tsk_1", slot: sent?.slot, attempt: sent?.attempt, sessionRef: STARTED_SESSION, continuedFrom: null, presetId: "pre_1", presetRevision: 2, presetNameAtStart: "Careful reviewer", createdAt: 1, liveness: "live", handoff: "sent" }, created: true })
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
    openPresetSettings,
  })

  render(() => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DialogProvider>
        <TasksSurface page={page} />
      </DialogProvider>
    </QueryClientProvider>
  ))
  return { openSession, openPresetSettings, requested, page }
}

const link = (liveness: SessionLiveness, slot: ConfigurationSlot = "primary") =>
  linkView(
    linkRow({
      taskId: "tsk_1",
      slot,
      attempt: 1,
      sessionRef: { sessionId: `ses_${slot}`, workspaceId: null },
      presetId: "pre_1",
      presetRevision: 2,
      presetNameAtStart: "Careful reviewer",
    }),
    liveness,
    liveness === "live" ? "sent" : "unknown",
  )

describe("starting and opening from a list row", () => {
  test("a row with no preset saved sends the user to the Presets settings", async () => {
    const { openPresetSettings } = mount({ presets: [] })

    fireEvent.click(await waitFor(() => screen.getByTestId("tasks-list-start-menu-tsk_1")))
    fireEvent.click(screen.getByTestId("tasks-list-preset-settings-tsk_1"))

    expect(openPresetSettings).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("tasks-list")).toBeTruthy()
  })

  /**
   * The service accepts the slot's current attempt only while its session is
   * live, and `current + 1` once it is gone. A row that always previewed 1 was
   * refused by every slot that had already run — and a row that previewed the
   * right attempt but never sent the start left the user on the list.
   */
  test("Start on a slot whose session is gone sends the attempt it previewed and opens what came back", async () => {
    const { requested, openSession } = mount({ links: [link("deleted")] })

    // A slot that has run shows Open on the main part, so starting again is
    // the caret's job.
    fireEvent.click(await waitFor(() => screen.getByTestId("tasks-list-start-menu-tsk_1")))
    fireEvent.click(screen.getByTestId("tasks-list-start-tsk_1-pre_1-primary"))

    const start = await waitFor(() => {
      const found = requested.find((entry) => entry.path === "/tasks/tsk_1/sessions")
      if (!found) throw new Error("no start was sent")
      return found
    })
    const preview = requested.find((entry) => entry.path.startsWith("/tasks/tsk_1/start-preview"))
    expect(preview?.body).toMatchObject({ slot: "primary", attempt: 2 })
    expect(start.body).toMatchObject({ slot: "primary", attempt: 2, previewDigest: PREVIEW_DIGEST })
    await waitFor(() => expect(openSession).toHaveBeenCalledWith(STARTED_SESSION))
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

    await waitFor(() => expect(openSession).toHaveBeenCalledWith({ sessionId: "ses_primary", workspaceId: null }))
  })

  /**
   * A row offers Open on its link count, which says nothing about the slot.
   * Assuming primary made a task started on Review alone offer Open and then
   * report that it had no session at all.
   */
  test("Open goes to the session of whichever slot ran", async () => {
    const { openSession } = mount({ links: [link("live", "review")] })

    fireEvent.click(await waitFor(() => screen.getByTestId("tasks-list-open-session-tsk_1")))

    await waitFor(() => expect(openSession).toHaveBeenCalledWith({ sessionId: "ses_review", workspaceId: null }))
  })
})

/**
 * The task page starts through the same control a row does, so these drive it
 * the way a person does: open the task, then press what is on the slot.
 */
async function openTaskPage() {
  fireEvent.click(await waitFor(() => screen.getByTestId("tasks-list-row-tsk_1")))
  return await waitFor(() => screen.getByTestId("task-detail-page"))
}

function sentTo(requested: { path: string; body?: unknown }[], path: string) {
  return waitFor(() => {
    const found = requested.find((entry) => entry.path === path)
    if (!found) throw new Error(`nothing was sent to ${path}`)
    return found
  })
}

describe("starting a task from its own page", () => {
  test("Start runs the default preset on the attempt the slot will take", async () => {
    const { requested, openSession } = mount({ links: [] })
    await openTaskPage()

    fireEvent.click(await waitFor(() => screen.getByTestId("task-slot-primary-start-tsk_1")))

    const start = await sentTo(requested, "/tasks/tsk_1/sessions")
    const preview = requested.find((entry) => entry.path.startsWith("/tasks/tsk_1/start-preview"))
    expect(preview?.body).toMatchObject({ slot: "primary", attempt: 1, continueFromPrevious: false })
    expect(start.body).toMatchObject({ presetId: "pre_1", slot: "primary", attempt: 1, previewDigest: PREVIEW_DIGEST })
    await waitFor(() => expect(openSession).toHaveBeenCalledWith(STARTED_SESSION))
  })

  test("a slot whose session is gone starts again on the next attempt", async () => {
    const { requested } = mount({ links: [link("deleted")] })
    await openTaskPage()

    const control = await waitFor(() => screen.getByTestId("task-slot-primary-start-tsk_1"))
    expect(control.textContent).toBe("Start again")
    fireEvent.click(control)

    const start = await sentTo(requested, "/tasks/tsk_1/sessions")
    expect(start.body).toMatchObject({ slot: "primary", attempt: 2 })
  })

  test("the caret starts the preset it was asked for, not the default", async () => {
    const other: Preset = { ...preset, id: "pre_2", name: "Alt voice" }
    const { requested } = mount({ presets: [preset, other] })
    await openTaskPage()

    fireEvent.click(await waitFor(() => screen.getByTestId("task-slot-primary-start-menu-tsk_1")))
    fireEvent.click(screen.getByTestId("task-slot-primary-start-tsk_1-pre_2-primary"))

    const start = await sentTo(requested, "/tasks/tsk_1/sessions")
    expect(start.body).toMatchObject({ presetId: "pre_2", slot: "primary", attempt: 1 })
  })

  /**
   * Continue repeats the preset the gone attempt ran, under the next attempt,
   * with the previous session rendered into it.
   */
  test("a gone slot can be continued from, where the host can still read it", async () => {
    const { requested } = mount({ links: [link("archived")], transcriptReadable: true })
    await openTaskPage()

    fireEvent.click(await waitFor(() => screen.getByTestId("task-slot-primary-start-menu-tsk_1")))
    fireEvent.click(screen.getByTestId("task-slot-primary-continue-tsk_1"))

    const start = await sentTo(requested, "/tasks/tsk_1/sessions")
    expect(start.body).toMatchObject({ presetId: "pre_1", slot: "primary", attempt: 2, continueFromPrevious: true })
  })

  /**
   * The service drops a transcript it cannot read and starts a fresh session
   * anyway, which is not what continuing means — so nothing is sent.
   */
  test("a continue the host cannot read is refused instead of started as a fresh session", async () => {
    const { requested } = mount({ links: [link("archived")], transcriptReadable: false })
    await openTaskPage()

    fireEvent.click(await waitFor(() => screen.getByTestId("task-slot-primary-start-menu-tsk_1")))
    fireEvent.click(screen.getByTestId("task-slot-primary-continue-tsk_1"))

    await waitFor(() =>
      expect(screen.getByTestId("task-slot-primary-start-blocker-tsk_1").textContent).toContain("nothing to continue from"),
    )
    expect(requested.some((entry) => entry.path === "/tasks/tsk_1/sessions")).toBe(false)
  })

  test("a deleted session is not offered as one to continue from", async () => {
    mount({ links: [link("deleted")], transcriptReadable: true })
    await openTaskPage()

    fireEvent.click(await waitFor(() => screen.getByTestId("task-slot-primary-start-menu-tsk_1")))

    expect(screen.queryByTestId("task-slot-primary-continue-tsk_1")).toBeNull()
  })
})
