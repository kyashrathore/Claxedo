import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { TASKS_ROUTE_PATH, type Preset, type SessionReference, type StartPreview, type Task } from "@claxedo/tasks"
import { configureTasksAppPorts } from "@/features/tasks/app-ports"
import { createTasksStore } from "@/features/tasks/store/tasks-store"
import { StartTaskFlow } from "@/features/tasks/ui/start-task-flow"

afterEach(cleanup)

const SERVER = "http://tasks.test"

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
  parentTaskId: null,
  title: "Ship the importer",
  description: "",
  status: "doing",
  childSetRevision: 0,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 2,
}

function previewOf(input: { continueFromPrevious: boolean; previousTranscriptReadable: boolean }): StartPreview {
  return {
    // The host hashes the resolved input, so including the transcript is a
    // different preview than the same settings without it.
    digest: input.continueFromPrevious ? "digest_with_transcript" : "digest_plain",
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

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
}

type Body = Record<string, unknown>

/**
 * A fake host at the HTTP boundary: the real client, decoders and query owner
 * run against it, and `previousTranscriptReadable` arrives the way the host
 * reports it rather than being supplied to the dialog directly.
 */
function mount(input: { previousTranscriptReadable: boolean }) {
  const previews: Body[] = []
  const starts: Body[] = []
  const openSession = vi.fn<(session: SessionReference) => void>()

  configureTasksAppPorts({
    useScope: () => () => ({ serverUrl: SERVER, scopeId: "local" }),
    request: async (url, init) => {
      const path = url.slice(`${SERVER}${TASKS_ROUTE_PATH}`.length)
      const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Body)
      if (path.startsWith("/presets")) return json({ items: [preset], nextCursor: null })
      if (path.endsWith("/start-preview")) {
        previews.push(body!)
        return json({
          preview: previewOf({
            continueFromPrevious: body!.continueFromPrevious === true,
            previousTranscriptReadable: input.previousTranscriptReadable,
          }),
        })
      }
      if (path.endsWith("/sessions")) {
        starts.push(body!)
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
    useOpenSession: () => openSession,
  })

  const onClose = vi.fn()
  render(() => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <StartTaskFlow
        store={createTasksStore()}
        scope={() => ({ serverUrl: SERVER, scopeId: "local" })}
        task={task}
        slot="primary"
        attempt={2}
        onClose={onClose}
      />
    </QueryClientProvider>
  ))
  return { previews, starts, openSession, onClose }
}

async function choosePreset() {
  await waitFor(() => expect(screen.getByTestId("start-task-preset").querySelectorAll("option")).toHaveLength(2))
  fireEvent.change(screen.getByTestId("start-task-preset"), { target: { value: preset.id } })
}

describe("start task flow against a fake host", () => {
  test("Continue appears on the host's readable transcript, re-previews on toggle and starts with the flag", async () => {
    const { previews, starts, openSession } = mount({ previousTranscriptReadable: true })
    await choosePreset()

    await waitFor(() => expect(previews).toHaveLength(1))
    expect(previews[0].continueFromPrevious).toBe(false)
    const row = await waitFor(() => screen.getByTestId("start-task-continue"))
    expect((row as HTMLInputElement).checked).toBe(false)

    fireEvent.click(row)

    await waitFor(() => expect(previews).toHaveLength(2))
    expect(previews[1].continueFromPrevious).toBe(true)
    // The row is what the user just clicked; a re-preview may not pull it out
    // from under them.
    expect(screen.getByTestId("start-task-continue")).toBe(row)

    await waitFor(() => expect(screen.getByTestId("start-task-submit")).not.toBeDisabled())
    fireEvent.click(screen.getByTestId("start-task-submit"))

    await waitFor(() => expect(starts).toHaveLength(1))
    expect(starts[0].continueFromPrevious).toBe(true)
    expect(starts[0].previewDigest).toBe("digest_with_transcript")
    await waitFor(() => expect(openSession).toHaveBeenCalledWith({ sessionId: "ses_2", workspaceId: "ws_1" }))
  })

  test("a host that cannot read the previous transcript offers no Continue row", async () => {
    const { previews } = mount({ previousTranscriptReadable: false })
    await choosePreset()

    await waitFor(() => expect(previews).toHaveLength(1))
    await waitFor(() => expect(screen.getByTestId("start-task-submit")).not.toBeDisabled())
    expect(screen.queryByTestId("start-task-continue-row")).toBeNull()
  })
})
