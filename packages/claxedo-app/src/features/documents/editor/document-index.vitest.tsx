import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { beforeEach, describe, expect, test, vi } from "vitest"

const api = vi.hoisted(() => ({
  create: vi.fn(),
  createFromRepository: vi.fn(),
  list: vi.fn(),
  listStatuses: vi.fn(),
  transitionStatus: vi.fn(),
}))

// The index reads the `document.changed` doorbell off the central events stream
// instead of holding its own `/documents/events` SSE (plan 2026-07-17-004 Wave
// 2-C). Stand in for the events context the app ports would supply.
//
// `centralConnected`, not the aggregate `connected`: the doorbell rides the
// central stream, so that is the signal the index bridges to its controller.
const events = vi.hoisted(() => ({
  on: vi.fn(),
  centralConnected: vi.fn(() => true),
  unsubscribes: [] as Array<{ calls: number }>,
}))

vi.mock("../data/documents-api", () => ({ documentsApi: api }))
vi.mock("../app-ports", () => ({ claxedoEventsPort: () => () => events }))

import { PageIndex } from "./document-index"

// `project_id` is the SERVER's id, not the app's: a loopback request resolves
// the project from the directory and answers with its own `project_<uuid>`
// (`resolveLocalProjectId`). The fixtures use that shape on purpose — keying
// anything in the UI off this value is the bug, not the contract.
const doc = (over: Record<string, unknown>) => ({
  id: "document_1",
  display_name: "Document",
  project_id: "project_4c4e6dc5a1124db98c55e173a8caa817",
  origin_kind: "managed",
  repository_relative_path: null,
  status: "draft",
  updated_at: "2026-07-17T00:00:00Z",
  ...over,
})

describe("PageIndex", () => {
  beforeEach(() => {
    api.create.mockReset()
    api.createFromRepository.mockReset()
    api.list.mockReset().mockResolvedValue([])
    api.listStatuses.mockReset().mockResolvedValue([])
    api.transitionStatus.mockReset().mockResolvedValue({})
    events.unsubscribes = []
    events.centralConnected.mockReset().mockReturnValue(true)
    events.on.mockReset().mockImplementation(() => {
      const record = { calls: 0 }
      events.unsubscribes.push(record)
      return () => {
        record.calls++
      }
    })
  })

  test("prevents duplicate managed creates while one request is pending", async () => {
    let resolveCreate!: (document: { id: string; display_name: string; project_id: string }) => void
    api.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve
        }),
    )
    const onOpenPage = vi.fn()
    render(() => (
      <PageIndex
        scope="project"
        directory="/repo"
        projects={[{ id: "project_1", worktree: "/repo", workspaceId: "workspace_1" }]}
        onOpenPage={onOpenPage}
      />
    ))
    const create = await screen.findByRole("button", { name: "New document" })

    fireEvent.click(create)
    fireEvent.click(create)
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(create).toBeDisabled()

    const document = { id: "document_1", display_name: "Untitled document", project_id: "project_1" }
    resolveCreate(document)
    // Opened against the project we placed it in, so the tab lands in that
    // project's workspace rather than whichever one is focused.
    await waitFor(() => expect(onOpenPage).toHaveBeenCalledWith(document, "project_1"))
    expect(create).toBeEnabled()
  })

  test("ignores managed create completion after unmount", async () => {
    let resolveCreate!: (document: { id: string; display_name: string; project_id: string }) => void
    api.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve
        }),
    )
    const onOpenPage = vi.fn()
    const view = render(() => (
      <PageIndex
        scope="project"
        directory="/repo"
        projects={[{ id: "project_1", worktree: "/repo", workspaceId: "workspace_1" }]}
        onOpenPage={onOpenPage}
      />
    ))
    fireEvent.click(await screen.findByRole("button", { name: "New document" }))
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
    view.unmount()
    resolveCreate({ id: "late_document", display_name: "Late", project_id: "project_1" })
    await Promise.resolve()
    await Promise.resolve()

    expect(onOpenPage).not.toHaveBeenCalled()
  })

  // Adding a repository file to Documents belongs on the Markdown file itself
  // (the "Add to Documents" action in the workspace panel's file view), not on
  // an index that asked you to retype the path of a file you were looking at.
  test("does not carry a repository importer", async () => {
    render(() => (
      <PageIndex
        scope="project"
        directory="/repo"
        projects={[{ id: "project_1", worktree: "/repo", workspaceId: "workspace_1" }]}
        onOpenPage={() => undefined}
      />
    ))
    await screen.findByRole("button", { name: "New document" })

    expect(screen.queryByRole("button", { name: "Add to Documents" })).not.toBeInTheDocument()
    expect(screen.queryByRole("textbox", { name: "Repository Markdown path" })).not.toBeInTheDocument()
    expect(api.createFromRepository).not.toHaveBeenCalled()
  })

  test("uses the matching project and arbitrary workspace-map entry for signed repository scope", async () => {
    render(() => (
      <PageIndex
        scope="project"
        directory="/remote/repo"
        projects={[
          { id: "wrong", worktree: "/other", workspaceId: "wrong-workspace" },
          {
            id: "project_signed",
            worktree: "/local/repo",
            workspaces: {
              alias: { directory: "/remote/repo", workspaceId: "workspace_signed", kind: "cloud" },
            },
          },
        ]}
        onOpenPage={() => undefined}
      />
    ))

    await waitFor(() => expect(api.list).toHaveBeenCalledWith({ projectId: "project_signed", directory: "/remote/repo" }))
  })

  test("fails closed when directory-only signed scope has no authoritative project mapping", async () => {
    render(() => (
      <PageIndex
        scope="project"
        directory="/remote/missing"
        projects={[{ id: "project_1", worktree: "/repo", workspaceId: "workspace_1" }]}
        onOpenPage={() => undefined}
      />
    ))
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a project")
    expect(screen.getByRole("button", { name: "New document" })).toBeDisabled()
    expect(api.list).not.toHaveBeenCalled()
  })

  test("starts from delayed inventory and loads with the resolved signed identities", async () => {
    const [projects, setProjects] = createSignal<Parameters<typeof PageIndex>[0]["projects"]>([])
    render(() => (
      <PageIndex scope="project" directory="/remote/delayed" projects={projects()} onOpenPage={() => undefined} />
    ))

    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a project")
    expect(api.list).not.toHaveBeenCalled()
    setProjects([
      {
        id: "project_delayed",
        worktree: "/local/delayed",
        workspaces: {
          signed: { directory: "/remote/delayed", workspaceId: "workspace_delayed", kind: "user-hosted" },
        },
      },
    ])

    await waitFor(() =>
      expect(api.list).toHaveBeenCalledWith({
        projectId: "project_delayed",
        directory: "/remote/delayed",
      }),
    )
    expect(api.listStatuses).toHaveBeenCalledWith({ projectId: "project_delayed", directory: "/remote/delayed" })
    expect(events.on).toHaveBeenCalledWith("document.changed", expect.any(Function))
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "New document" })).toBeEnabled()
  })

  test("switches project scope, unsubscribes the old doorbell, and ignores its stale list", async () => {
    let resolveOld!: (documents: Array<Record<string, unknown>>) => void
    const oldList = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolveOld = resolve
    })
    const current = doc({ id: "current", display_name: "Current document", project_id: "project_2" })
    api.list.mockImplementation((query: { projectId?: string }) =>
      query.projectId === "project_1" ? oldList : Promise.resolve([current]),
    )
    const [config, setConfig] = createSignal({
      directory: "/repo/one",
      projects: [{ id: "project_1", worktree: "/repo/one", workspaceId: "workspace_1" }],
    })
    render(() => (
      <PageIndex
        scope="project"
        directory={config().directory}
        projects={config().projects}
        onOpenPage={() => undefined}
      />
    ))
    await waitFor(() => expect(api.list).toHaveBeenCalledWith({ projectId: "project_1", directory: "/repo/one" }))
    await waitFor(() => expect(events.unsubscribes).toHaveLength(1))

    setConfig({
      directory: "/repo/two",
      projects: [{ id: "project_2", worktree: "/repo/two", workspaceId: "workspace_2" }],
    })
    await waitFor(() => expect(api.list).toHaveBeenCalledWith({ projectId: "project_2", directory: "/repo/two" }))
    await waitFor(() => expect(events.unsubscribes).toHaveLength(2))
    // The old scope's subscription must be released, or a stale project keeps
    // refreshing the list forever on a stream the controller no longer owns.
    expect(events.unsubscribes[0]?.calls).toBe(1)
    expect(events.unsubscribes[1]?.calls).toBe(0)
    expect(await screen.findByText("Current document")).toBeInTheDocument()

    resolveOld([doc({ id: "old", display_name: "Stale document", project_id: "project_1" })])
    await Promise.resolve()
    expect(screen.queryByText("Stale document")).not.toBeInTheDocument()
    expect(screen.getByText("Current document")).toBeInTheDocument()
    expect(events.on).toHaveBeenCalledTimes(2)
  })
})

// The standalone index used to send one query for `projects[0]` and present that
// project's documents as if they were every project's.
describe("PageIndex project grouping", () => {
  const projects = [
    { id: "project_1", worktree: "/code/alpha", workspaceId: "workspace_1" },
    { id: "project_2", worktree: "/code/beta", workspaceId: "workspace_2" },
  ]

  beforeEach(() => {
    api.create.mockReset()
    api.list.mockReset().mockImplementation((query: { projectId?: string }) =>
      Promise.resolve(
        query.projectId === "project_1"
          ? [doc({ id: "d1", display_name: "Alpha plan" })]
          : [doc({ id: "d2", display_name: "Beta notes" })],
      ),
    )
    api.listStatuses.mockReset().mockResolvedValue([])
    api.transitionStatus.mockReset().mockResolvedValue({})
    events.unsubscribes = []
    events.centralConnected.mockReset().mockReturnValue(true)
    events.on.mockReset().mockImplementation(() => () => undefined)
  })

  test("asks every project for its own documents and groups the merged list", async () => {
    render(() => <PageIndex scope="all" projects={projects} onOpenPage={() => undefined} />)

    // One authorized list per project: the server has no cross-project endpoint.
    // Both keys travel, because a loopback request resolves the project from the
    // directory and a signed one authorizes the id — each ignores the other.
    await waitFor(() => expect(api.list).toHaveBeenCalledWith({ projectId: "project_1", directory: "/code/alpha" }))
    expect(api.list).toHaveBeenCalledWith({ projectId: "project_2", directory: "/code/beta" })

    // Grouped under the project's worktree basename, not its opaque id.
    expect(await screen.findByRole("region", { name: "Project alpha" })).toBeInTheDocument()
    expect(screen.getByRole("region", { name: "Project beta" })).toBeInTheDocument()
    expect(screen.getByText("Alpha plan")).toBeInTheDocument()
    expect(screen.getByText("Beta notes")).toBeInTheDocument()
  })

  test("filters the list down to one project", async () => {
    render(() => <PageIndex scope="all" projects={projects} onOpenPage={() => undefined} />)
    await screen.findByText("Alpha plan")

    fireEvent.click(screen.getByRole("button", { name: "Filter by project" }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /beta/ }))

    await waitFor(() => expect(screen.queryByText("Alpha plan")).not.toBeInTheDocument())
    expect(screen.getByText("Beta notes")).toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "Project alpha" })).not.toBeInTheDocument()
  })

  test("pins the project scope to one project instead of the whole inventory", async () => {
    render(() => <PageIndex scope="project" directory="/code/alpha" projects={projects} onOpenPage={() => undefined} />)

    await waitFor(() => expect(api.list).toHaveBeenCalledWith({ projectId: "project_1", directory: "/code/alpha" }))
    expect(api.list).toHaveBeenCalledTimes(1)
    // A single-project surface has nothing to filter across.
    expect(screen.queryByRole("button", { name: "Filter by project" })).not.toBeInTheDocument()
  })
})

describe("PageIndex row status", () => {
  const projects = [{ id: "project_1", worktree: "/code/alpha", workspaceId: "workspace_1" }]
  const statuses = [
    { id: "draft", name: "Draft", color: "#888", position: 0, transitions: ["review"] },
    { id: "review", name: "In review", color: "#0a0", position: 1, transitions: [] },
  ]

  beforeEach(() => {
    api.list.mockReset().mockResolvedValue([doc({ id: "d1", display_name: "Alpha plan" })])
    api.listStatuses.mockReset().mockResolvedValue(statuses)
    api.transitionStatus.mockReset().mockResolvedValue({})
    events.centralConnected.mockReset().mockReturnValue(true)
    events.on.mockReset().mockImplementation(() => () => undefined)
  })

  test("moves a document through a server-allowed transition", async () => {
    render(() => <PageIndex scope="project" directory="/code/alpha" projects={projects} onOpenPage={() => undefined} />)

    const status = await screen.findByRole("button", { name: "Status for Alpha plan" })
    expect(status).toHaveTextContent("Draft")
    fireEvent.click(status)
    fireEvent.click(await screen.findByRole("menuitem", { name: "In review" }))

    await waitFor(() => expect(api.transitionStatus).toHaveBeenCalledWith("d1", "review"))
  })

  // Only the transitions the server allows are offered — a terminal status is a
  // label, not a dropdown that opens onto nothing.
  test("renders a status with no onward transition as plain text", async () => {
    api.list.mockResolvedValue([doc({ id: "d1", display_name: "Alpha plan", status: "review" })])
    render(() => <PageIndex scope="project" directory="/code/alpha" projects={projects} onOpenPage={() => undefined} />)

    await screen.findByText("Alpha plan")
    expect(screen.queryByRole("button", { name: "Status for Alpha plan" })).not.toBeInTheDocument()
    expect(screen.getByLabelText("Status for Alpha plan")).toHaveTextContent("In review")
  })
})
