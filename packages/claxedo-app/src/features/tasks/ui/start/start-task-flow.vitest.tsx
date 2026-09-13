import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { TASKS_ROUTE_PATH, type Preset, type SessionReference, type StartPreview, type Task } from "@claxedo/tasks"
import { configureTasksAppPorts } from "@/features/tasks/app-ports"
import { useTaskDetail, type TasksScope } from "@/features/tasks/data/queries"
import { createTasksStore } from "@/features/tasks/store/tasks-store"
import { StartTaskFlow } from "@/features/tasks/ui/start/start-task-flow"

vi.mock("@opencode-ai/ui/dropdown-menu", async () => (await import("../shared/test-support/host-controls")).dropdownMenuDouble())
import { chooseOption, optionLabels } from "../shared/test-support/host-controls"

vi.mock("@opencode-ai/ui/select", async () => (await import("../shared/test-support/host-controls")).selectDouble())

afterEach(cleanup)

const SERVER = "http://tasks.test"
const SCOPE: TasksScope = { serverUrl: SERVER, scopeId: "local" }

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

function previewOf(input: {
  continueFromPrevious: boolean
  previousTranscriptReadable: boolean
  taskRevision: number
}): StartPreview {
  return {
    // The host hashes the resolved input, so including the transcript and
    // rebasing onto another revision each produce a different preview.
    digest: `${input.continueFromPrevious ? "with_transcript" : "plain"}_r${input.taskRevision}`,
    expiresAt: 10_000,
    placement: "local",
    slot: "primary",
    attempt: 2,
    configuration: preset.configurations.primary,
    capabilities: { mode: "inherit-local" },
    available: true,
    blockers: [],
    currentSession: null,
    previousTranscriptReadable: input.previousTranscriptReadable,
    destinationDescription: "This machine, /repo/importer",
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function refusal(code: string, message: string, current?: Task) {
  return json({ error: { code, message, ...(current ? { currentTask: current } : {}) } }, 409)
}

type Body = Record<string, unknown>

/** Stands in for the detail read the panel behind the dialog holds. */
function DetailProbe() {
  const detail = useTaskDetail(
    () => SCOPE,
    () => task.id,
  )
  return <span data-testid="detail-revision">{detail.data?.task.revision ?? ""}</span>
}

/**
 * A fake host at the HTTP boundary: the real client, decoders and query owner
 * run against it, so `previousTranscriptReadable` and a stale revision arrive
 * the way the host reports them rather than being handed to the dialog.
 *
 * `advanceOnFirstStart` is the race the host's revision guard produces — a
 * session linked between this preview and this Start.
 */
function mount(input: {
  previousTranscriptReadable: boolean
  advanceOnFirstStart?: boolean
  refuseStartWithConflict?: boolean
  previewStaleAtOwnRevision?: boolean
  /** The revision the host holds, when it is ahead of the one the dialog opened with. */
  hostRevision?: number
}) {
  const previews: Body[] = []
  const starts: Body[] = []
  const openSession = vi.fn<(session: SessionReference) => void>()
  let revision = input.hostRevision ?? task.revision
  let advanceOnFirstStart = input.advanceOnFirstStart === true
  const current = (): Task => ({ ...task, revision })

  configureTasksAppPorts({
    useScope: () => () => SCOPE,
    request: async (url, init) => {
      const path = url.slice(`${SERVER}${TASKS_ROUTE_PATH}`.length)
      const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Body)
      if (path.startsWith("/presets")) return json({ items: [preset], nextCursor: null })
      if (path === `/tasks/${task.id}`) return json({ task: current(), links: [] })
      if (path.endsWith("/start-preview")) {
        previews.push(body!)
        if (input.previewStaleAtOwnRevision === true) {
          return refusal("stale_revision", `Task ${task.id} is at revision ${revision}`, current())
        }
        if (body!.taskRevision !== revision) return refusal("stale_revision", `Task ${task.id} is at revision ${revision}`, current())
        return json({
          preview: previewOf({
            continueFromPrevious: body!.continueFromPrevious === true,
            previousTranscriptReadable: input.previousTranscriptReadable,
            taskRevision: revision,
          }),
        })
      }
      if (path.endsWith("/sessions")) {
        starts.push(body!)
        if (input.refuseStartWithConflict === true) return refusal("conflict", `Task ${task.id} is archived`)
        if (advanceOnFirstStart) {
          advanceOnFirstStart = false
          revision += 1
          return refusal("stale_revision", `Task ${task.id} is at revision ${revision}`, current())
        }
        if (body!.taskRevision !== revision) return refusal("stale_revision", `Task ${task.id} is at revision ${revision}`, current())
        return json({
          link: {
            taskId: task.id,
            slot: "primary",
            attempt: 2,
            sessionRef: { sessionId: "ses_2", workspaceId: "ws_1" },
            continuedFrom: null,
            presetId: preset.id,
            presetRevision: preset.revision,
            presetNameAtStart: preset.name,
            createdAt: 5,
            liveness: "live",
            handoff: "sent",
          },
          created: true,
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

  const onClose = vi.fn()
  render(() => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DialogProvider>
        <DetailProbe />
        <StartTaskFlow
          store={createTasksStore()}
          scope={() => SCOPE}
          task={task}
          slot="primary"
          attempt={2}
          onClose={onClose}
        />
      </DialogProvider>
    </QueryClientProvider>
  ))
  return { previews, starts, openSession, onClose }
}

async function choosePreset() {
  await waitFor(() => expect(optionLabels("start-task-preset")).toEqual([preset.name]))
  chooseOption("start-task-preset", preset.name)
}

async function clickStart() {
  await waitFor(() => expect(screen.getByTestId("start-task-submit")).not.toBeDisabled())
  fireEvent.click(screen.getByTestId("start-task-submit"))
}

describe("start task flow against a fake host", () => {
  test("Continue appears on the host's readable transcript, re-previews on toggle and starts with the flag", async () => {
    const { previews, starts, openSession } = mount({ previousTranscriptReadable: true })
    await choosePreset()

    await waitFor(() => expect(previews).toHaveLength(1))
    expect(previews[0].continueFromPrevious).toBe(false)
    const row = await waitFor(() => screen.getByTestId("start-task-continue"))
    const box = within(row).getByRole<HTMLInputElement>("checkbox")
    expect(box.checked).toBe(false)

    fireEvent.click(box)

    await waitFor(() => expect(previews).toHaveLength(2))
    expect(previews[1].continueFromPrevious).toBe(true)
    // The row is what the user just clicked; a re-preview may not pull it out
    // from under them.
    expect(screen.getByTestId("start-task-continue")).toBe(row)

    await clickStart()

    await waitFor(() => expect(starts).toHaveLength(1))
    expect(starts[0].continueFromPrevious).toBe(true)
    expect(starts[0].previewDigest).toBe("with_transcript_r4")
    await waitFor(() => expect(openSession).toHaveBeenCalledWith({ sessionId: "ses_2", workspaceId: "ws_1" }))
  })

  test("a host that cannot read the previous transcript offers no Continue row", async () => {
    const { previews } = mount({ previousTranscriptReadable: false })
    await choosePreset()

    await waitFor(() => expect(previews).toHaveLength(1))
    await waitFor(() => expect(screen.getByTestId("start-task-submit")).not.toBeDisabled())
    expect(screen.queryByTestId("start-task-continue-row")).toBeNull()
  })

  test("a Start refused on a stale revision rebases, re-previews and succeeds on the retry", async () => {
    const { previews, starts, openSession, onClose } = mount({
      previousTranscriptReadable: false,
      advanceOnFirstStart: true,
    })
    await choosePreset()
    await clickStart()

    await waitFor(() => expect(starts).toHaveLength(2))
    expect(starts.map((body) => body.taskRevision)).toEqual([4, 5])
    // The retry cannot reuse the digest the stale revision produced: the host
    // binds a preview to the revision it resolved against.
    expect(previews.at(-1)?.taskRevision).toBe(5)
    expect(starts[1].previewDigest).toBe("plain_r5")
    await waitFor(() => expect(openSession).toHaveBeenCalledWith({ sessionId: "ses_2", workspaceId: "ws_1" }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("alert")).toBeNull()
  })

  test("a successful Start refetches the task detail, so the panel shows the revision the link advanced", async () => {
    const { starts } = mount({ previousTranscriptReadable: false, advanceOnFirstStart: true })
    await waitFor(() => expect(screen.getByTestId("detail-revision").textContent).toBe("4"))
    await choosePreset()
    await clickStart()

    await waitFor(() => expect(starts).toHaveLength(2))
    await waitFor(() => expect(screen.getByTestId("detail-revision").textContent).toBe("5"))
  })

  test("a preview refused on a stale revision rebases itself, so Start is reachable at all", async () => {
    const { previews, starts } = mount({ previousTranscriptReadable: false, hostRevision: 5 })
    await choosePreset()

    await waitFor(() => expect(previews.map((body) => body.taskRevision)).toEqual([4, 5]))
    await clickStart()

    await waitFor(() => expect(starts).toHaveLength(1))
    expect(starts[0].taskRevision).toBe(5)
    expect(starts[0].previewDigest).toBe("plain_r5")
  })

  test("a host that reports the revision the client already claims is not re-previewed forever", async () => {
    const { previews } = mount({ previousTranscriptReadable: false, previewStaleAtOwnRevision: true })
    await choosePreset()

    await waitFor(() => expect(screen.getByTestId("start-task-preview-error")).toBeTruthy())
    expect(previews).toHaveLength(1)
    expect(screen.getByTestId("start-task-submit")).toBeDisabled()
  })

  test("a refusal with nothing to rebase onto is surfaced after one attempt", async () => {
    const { starts, openSession } = mount({ previousTranscriptReadable: false, refuseStartWithConflict: true })
    await choosePreset()
    await clickStart()

    await waitFor(() => expect(screen.getByText(`Task ${task.id} is archived`)).toBeTruthy())
    expect(starts).toHaveLength(1)
    expect(openSession).not.toHaveBeenCalled()
  })
})
