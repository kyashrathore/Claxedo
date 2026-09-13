import { createSignal } from "solid-js"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { NewSessionProjectSelection } from "@/features/session/ui/components/session-new-design-view"
import { FirstProjectCanvas } from "./first-project-canvas"

const health = vi.hoisted(() => ({ localExecution: true as boolean | undefined }))
const createIntent = vi.hoisted(() => ({ requests: 0, bump: () => {} }))
const created = vi.hoisted(() => ({
  calls: [] as { baseUrl?: string; name: string; source: unknown }[],
  checkoutDirectory: "/home/me/demo" as string | null,
}))

vi.mock("@/app/connection/server", () => ({
  useServer: () => ({ url: "http://server.test" }),
}))

vi.mock("@/app/connection/server-health", () => ({
  serverHealthQueryOptions: () => ({
    queryKey: ["server", "health", "test"],
    queryFn: async () => ({ healthy: true, localExecution: health.localExecution }),
  }),
}))

vi.mock("@/app/providers/config", () => ({
  useConfigOptional: () => ({ authEnabled: false }),
}))

vi.mock("@/app/providers/layout", () => ({
  useLayout: () => ({ projects: { createRequests: () => createIntent.requests } }),
}))

vi.mock("@/app/integrations/sync/query-options", () => ({
  useShellQueryOptions: () => ({ projects: () => ({ queryKey: ["projects"], queryFn: async () => [] }) }),
}))

vi.mock("@/features/workspaces/data/query/project-ensure", () => ({
  refreshProjectInventory: async () => [],
}))

vi.mock("@/platform/runtime/platform-provider", () => ({
  usePlatform: () => ({ platform: "web" }),
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ show: () => undefined }),
}))

// The folder source opens a dialog outside this tree; the picker's own contract
// is "resolves to a path or undefined", which is all this screen consumes.
vi.mock("@/features/session/ui/components/session-pick-project-folder", () => ({
  pickProjectFolderWith: () => async () => "/home/me/demo",
}))

vi.mock("@/features/workspaces/data/project-api", () => ({
  createProject: async (input: { baseUrl?: string; name: string; source: unknown }) => {
    created.calls.push(input)
    return {
      id: "prj_1",
      name: input.name,
      env: {},
      checkoutDirectory: created.checkoutDirectory,
      repoUrl: null,
      created_at: 1,
      updated_at: 1,
    }
  },
  projectRequestMessage: (cause: unknown) => String(cause),
}))

// `createRequests` is a counter the mounted surface answers; the signal makes
// the component re-read it the way the real layout store does.
const [requests, setRequests] = createSignal(0)
createIntent.bump = () => setRequests(requests() + 1)
Object.defineProperty(createIntent, "requests", { get: () => requests() })

const renderCanvas = (props: Parameters<typeof FirstProjectCanvas>[0] = {}) =>
  render(() => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FirstProjectCanvas {...props} />
    </QueryClientProvider>
  ))

afterEach(() => {
  health.localExecution = true
  created.calls = []
  created.checkoutDirectory = "/home/me/demo"
  cleanup()
})

describe("FirstProjectCanvas", () => {
  test("opens on the create form itself, with no chip or button standing between", async () => {
    renderCanvas()

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Start with a project")
    expect(screen.getByRole("textbox", { name: "Project name" })).toBeTruthy()
    await waitFor(() => expect(screen.getByRole("button", { name: "Choose folder" })).toBeTruthy())
    expect(screen.getByRole("button", { name: "Create project" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Select project" })).toBeNull()
    expect(screen.queryByRole("button", { name: "New Project" })).toBeNull()
    expect(screen.queryByText("No projects yet. Create one to get started.")).toBeNull()
  })

  test("a server without its own filesystem offers the repository source only", async () => {
    health.localExecution = false
    renderCanvas()

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Repository URL" })).toBeTruthy())
    expect(screen.queryByRole("button", { name: "Choose folder" })).toBeNull()
  })

  test("a created project reaches onProjectCreated as the record the shell opens", async () => {
    const opened: NewSessionProjectSelection[] = []
    renderCanvas({ onProjectCreated: (project) => opened.push(project) })

    await waitFor(() => expect(screen.getByRole("button", { name: "Choose folder" })).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }))
    await waitFor(() => expect(screen.getByText("/home/me/demo")).toBeTruthy())

    fireEvent.click(screen.getByRole("button", { name: "Create project" }))
    await waitFor(() => expect(opened).toEqual([{ id: "prj_1", worktree: "/home/me/demo" }]))
    expect(created.calls).toEqual([
      { baseUrl: "http://server.test", name: "demo", source: { kind: "directory", folder: "/home/me/demo" } },
    ])
  })

  test("a checkout the app cannot open is refused rather than handed on", async () => {
    created.checkoutDirectory = "/workspace"
    const opened: NewSessionProjectSelection[] = []
    renderCanvas({ onProjectCreated: (project) => opened.push(project) })

    await waitFor(() => expect(screen.getByRole("button", { name: "Choose folder" })).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }))
    await waitFor(() => expect(screen.getByText("/home/me/demo")).toBeTruthy())

    fireEvent.click(screen.getByRole("button", { name: "Create project" }))
    await waitFor(() => expect(created.calls.length).toBe(1))
    expect(opened).toEqual([])
  })

  test("answers the shell's create-project intent by focusing the name field", async () => {
    renderCanvas()
    const name = screen.getByRole("textbox", { name: "Project name" })
    expect(document.activeElement).not.toBe(name)

    createIntent.bump()
    await waitFor(() => expect(document.activeElement).toBe(name))
  })

  test("Diagnostics appears only when the shell supplies it", async () => {
    renderCanvas()
    expect(screen.queryByTestId("empty-diagnostics-trigger")).toBeNull()
    cleanup()

    let diagnostics = 0
    renderCanvas({ onDiagnostics: () => (diagnostics += 1) })
    fireEvent.click(screen.getByTestId("empty-diagnostics-trigger"))
    expect(diagnostics).toBe(1)
  })
})
