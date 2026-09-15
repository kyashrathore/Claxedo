import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import {
  TASKS_ROUTE_PATH,
  linkView,
  type ModelConfiguration,
  type SessionHandoffState,
  type Task,
} from "@claxedo/tasks"
import { linkRow, taskRow } from "@claxedo/tasks/test-support"
import { configureTasksAppPorts } from "@/features/tasks/app-ports"
import type { TasksScope } from "@/features/tasks/data/queries"
import { createTasksStore } from "@/features/tasks/store/tasks-store"
import { TaskDetailPage } from "@/features/tasks/ui/detail/task-detail-page"

afterEach(cleanup)

const SERVER = "http://tasks.test"
const SCOPE: TasksScope = { serverUrl: SERVER, scopeId: "local" }

const configuration: ModelConfiguration = {
  harness: { id: "claude", access: "native" },
  model: { providerID: "anthropic", modelID: "sonnet" },
  effort: null,
}

const task: Task = taskRow({ id: "tsk_1", revision: 4, title: "Ship the importer", status: "doing", updatedAt: 2 })

/** The slot's current attempt, as the host reports it over the wire. */
const liveLink = (handoff: SessionHandoffState) =>
  linkView(
    linkRow({
      taskId: task.id,
      attempt: 2,
      sessionRef: { sessionId: "ses_2", workspaceId: "ws_1" },
      presetId: "pre_1",
      presetRevision: 3,
      presetNameAtStart: "Careful reviewer",
      createdAt: 5,
    }),
    "live",
    handoff,
  )

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

type Body = Record<string, unknown>

/**
 * A fake host at the HTTP boundary: the real client, decoders, query owner and
 * panel run against it, so the handoff state arrives the way the host reports
 * it and the recovery is the request the route would receive.
 *
 * A Start that names a live slot's current attempt is the server's idempotent
 * path: it submits the message the link persisted, after which the host's
 * readback finds it.
 */
function mount(input: { handoff: SessionHandoffState; refuseStart?: string }) {
  const starts: Body[] = []
  const previews: Body[] = []
  let handoff = input.handoff
  const openSession = vi.fn()

  configureTasksAppPorts({
    useScope: () => () => SCOPE,
    request: async (url, init) => {
      const path = url.slice(`${SERVER}${TASKS_ROUTE_PATH}`.length)
      const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Body)
      if (path.startsWith(`/tasks/${task.id}/children`)) return json({ items: [], nextCursor: null })
      if (path.startsWith("/presets")) return json({ items: [], nextCursor: null })
      if (path === `/tasks/${task.id}`) {
        return json({
          task,
          links: [liveLink(handoff)],
          attachments: [],
        })
      }
      if (path.endsWith("/start-preview")) {
        previews.push(body!)
        return json({
          preview: {
            digest: "plain_r4",
            expiresAt: 10_000,
            placement: "local",
            slot: "primary",
            attempt: 2,
            configuration,
            capabilities: { mode: "inherit-local" },
            available: true,
            blockers: [],
            currentSession: { sessionRef: { sessionId: "ses_2", workspaceId: "ws_1" }, liveness: "live" },
            previousTranscriptReadable: false,
            destinationDescription: "This machine, /repo/importer",
          },
        })
      }
      if (path.endsWith("/sessions")) {
        starts.push(body!)
        if (input.refuseStart) return json({ error: { code: "conflict", message: input.refuseStart } }, 409)
        handoff = "sent"
        return json({
          link: liveLink("sent"),
          created: false,
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
    useOpenSession: () => openSession,
    useOpenPage: () => () => {},
    openPresetSettings: () => {},
  })

  render(() => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DialogProvider>
        <TaskDetailPage
          store={createTasksStore()}
          scope={() => SCOPE}
          taskId={task.id}
          onOpenTask={vi.fn()}
          onBack={vi.fn()}
          onOpenProject={vi.fn()}
        />
      </DialogProvider>
    </QueryClientProvider>
  ))
  return { starts, previews, openSession }
}

async function sendControl() {
  return waitFor(() => screen.getByTestId("task-slot-send-primary"))
}

describe("first-message recovery against a fake host", () => {
  test("a live link the host reports unsent offers Send task, which delivers the attempt it already holds", async () => {
    const { starts, openSession } = mount({ handoff: "pending" })

    expect((await waitFor(() => screen.getByTestId("task-slot-handoff-primary"))).textContent).toBe("Task not sent yet")
    fireEvent.click(await sendControl())

    await waitFor(() => expect(starts).toHaveLength(1))
    expect(starts[0]).toMatchObject({ slot: "primary", attempt: 2, presetId: "pre_1", presetRevision: 3, taskRevision: 4 })
    // The text is the one the link persisted at Start; a resend that carried
    // its own would hand the session a different message.
    expect(starts[0].handoffText).toBeNull()

    await waitFor(() => expect(screen.queryByTestId("task-slot-send-primary")).toBeNull())
    expect(screen.queryByTestId("task-slot-handoff-primary")).toBeNull()
    expect(starts).toHaveLength(1)
    expect(openSession).not.toHaveBeenCalled()
  })

  test("a host that cannot say whether the message landed offers no resend", async () => {
    mount({ handoff: "unknown" })

    expect((await waitFor(() => screen.getByTestId("task-slot-handoff-primary"))).textContent).toBe("Delivery unknown")
    expect(screen.queryByTestId("task-slot-send-primary")).toBeNull()
  })

  test("a delivered message says nothing at all", async () => {
    mount({ handoff: "sent" })

    await waitFor(() => expect(screen.getByTestId("task-slot-open-primary")).toBeTruthy())
    expect(screen.queryByTestId("task-slot-handoff-primary")).toBeNull()
    expect(screen.queryByTestId("task-slot-send-primary")).toBeNull()
  })

  test("a refused resend is surfaced and the control stays, because the message is still unsent", async () => {
    const { starts } = mount({ handoff: "pending", refuseStart: "Preset pre_1 is archived" })

    fireEvent.click(await sendControl())

    await waitFor(() => expect(screen.getByText("Preset pre_1 is archived")).toBeTruthy())
    expect(starts).toHaveLength(1)
    expect(screen.getByTestId("task-slot-send-primary")).toBeTruthy()
  })
})
