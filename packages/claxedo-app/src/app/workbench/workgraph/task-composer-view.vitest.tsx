import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { ErrorBoundary } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import { TaskComposerView } from "./task-composer-view"

const mocks = vi.hoisted(() => ({
  createWorkItem: vi.fn(async () => ({ ok: true })),
  lifecycle: vi.fn(),
  snapshot: vi.fn(async () => ({
    snapshotCursor: "cursor-1",
    records: [
      {
        recordType: "stream",
        id: "stream-1",
        title: "Ship it",
        executionDefaults: { agents: [], environment: { placement: "shared" } },
      },
    ],
  })),
  executionCapabilities: vi.fn(async () => ({
    harnesses: [{ id: "opencode" }],
    models: [{ harnessId: "opencode", providerId: "openai", modelId: "gpt-5", label: "GPT-5" }],
  })),
}))

vi.mock("@tanstack/solid-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/solid-query")>()),
  useQuery: () => ({ data: [{ worktree: "/repo/main", name: "Main" }] }),
}))
vi.mock("@/app/integrations/sync/query-options", () => ({
  useShellQueryOptions: () => ({ projects: () => ({}) }),
}))
vi.mock("@/features/session/ui/components/session-new-design-view", () => ({
  NewSessionDesignView: (props: { children: unknown }) => props.children,
}))
vi.mock("@/features/workgraph/sync-lifecycle", () => ({
  useWorkGraphSyncLifecycle: mocks.lifecycle,
}))
vi.mock("@/features/workgraph/workgraph-overview", () => ({
  StreamCard: () => null,
  streamProject: () => ({ key: "local:/repo/main" }),
}))
vi.mock("@/features/workgraph/api", () => ({
  createWorkGraphClient: () => ({
    snapshot: mocks.snapshot,
    executionCapabilities: mocks.executionCapabilities,
    createWorkItem: mocks.createWorkItem,
  }),
}))

afterEach(() => {
  cleanup()
  mocks.createWorkItem.mockClear()
  mocks.lifecycle.mockClear()
  mocks.snapshot.mockClear()
  mocks.executionCapabilities.mockClear()
})

describe("TaskComposerView", () => {
  test("keeps a zero-profile Stream executable with harness and model overrides", async () => {
    render(() => <TaskComposerView directory="/repo/main" />)

    expect(await screen.findByRole("combobox", { name: "Execution harness" })).toHaveValue("opencode")
    expect(screen.getByRole("combobox", { name: "Execution model" })).toHaveValue("openai/gpt-5")
    fireEvent.input(screen.getByRole("textbox", { name: "Task intent" }), { target: { value: "Close the loop" } })
    fireEvent.click(screen.getByRole("button", { name: "Create task" }))

    await waitFor(() =>
      expect(mocks.createWorkItem).toHaveBeenCalledWith(
        expect.objectContaining({
          streamId: "stream-1",
          execution: {
            harness: "opencode",
            model: { providerId: "openai", modelId: "gpt-5" },
          },
        }),
      ),
    )
    expect(mocks.lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ active: expect.any(Function), reload: expect.any(Function) }),
    )
  })

  // Owner-reported crash: clicking the top-level "New task" button blanked the
  // renderer. Both resources rejected against a fresh/unreachable WorkGraph
  // ledger, and with no ErrorBoundary between this view and the app root the
  // rejection propagated all the way up. The composer must degrade in place.
  test("stays mounted when the WorkGraph ledger is unreachable", async () => {
    mocks.snapshot.mockRejectedValueOnce(new Error("WorkGraph is offline"))
    mocks.executionCapabilities.mockRejectedValueOnce(new Error("WorkGraph is offline"))

    let boundaryError: unknown
    render(() => (
      <ErrorBoundary
        fallback={(error) => {
          boundaryError = error
          return <p>composer crashed</p>
        }}
      >
        <TaskComposerView directory="/repo/main" />
      </ErrorBoundary>
    ))

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("WorkGraph could not be loaded"))
    expect(boundaryError).toBeUndefined()
    expect(screen.queryByText("composer crashed")).toBeNull()
    expect(screen.getByText("New task")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Create task" })).toBeDisabled()
  })

  test("renders an empty Stream list without crashing on a fresh profile", async () => {
    mocks.snapshot.mockResolvedValueOnce({ snapshotCursor: "cursor-1", records: [] })

    let boundaryError: unknown
    render(() => (
      <ErrorBoundary
        fallback={(error) => {
          boundaryError = error
          return <p>composer crashed</p>
        }}
      >
        <TaskComposerView directory="/repo/main" />
      </ErrorBoundary>
    ))

    fireEvent.click(await screen.findByRole("tab", { name: "Streams" }))
    expect(await screen.findByText("No Streams belong to this project yet.")).toBeTruthy()
    expect(boundaryError).toBeUndefined()
  })
})
