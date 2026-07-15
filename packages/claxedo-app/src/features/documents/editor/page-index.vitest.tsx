import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
const api = vi.hoisted(() => ({
  list: vi.fn(),
  listStatuses: vi.fn(),
  create: vi.fn(),
  transitionStatus: vi.fn(),
  drop: vi.fn(),
  saveStatuses: vi.fn(),
  ensureLocalProject: vi.fn(),
  turnIntoWork: vi.fn(),
  openWorkGraph: vi.fn(),
  openGlobal: vi.fn(),
  showToast: vi.fn(),
}))
const context = vi.hoisted(() => ({
  useGlobalSDK: () => ({ url: "http://127.0.0.1:4096" }),
  useQueryOptions: () => ({
    projects: () => ({
      queryKey: ["projects"],
      queryFn: async () => [],
    }),
  }),
  usePlatform: () => ({}),
  useClaxedoState: () => ({
    layout: { openWorkGraph: api.openWorkGraph },
    workspacePanel: { openGlobal: api.openGlobal },
  }),
}))

vi.mock("@/features/documents/data/pages-api", () => ({
  pagesApi: {
    list: api.list,
    listStatuses: api.listStatuses,
    create: api.create,
    transitionStatus: api.transitionStatus,
    delete: api.drop,
    saveStatuses: api.saveStatuses,
  },
}))

vi.mock("@/features/documents/app-ports", () => ({
  ensureLocalProject: api.ensureLocalProject,
  useGlobalSDK: context.useGlobalSDK,
  useShellQueryOptions: context.useQueryOptions,
  useClaxedoState: context.useClaxedoState,
}))

vi.mock("@/features/documents/actions/doc-actions", () => ({
  turnDocumentRevisionIntoWork: api.turnIntoWork,
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ show: vi.fn() }),
}))

vi.mock("@opencode-ai/ui/toast", () => ({
  showToast: api.showToast,
}))

vi.mock("@/app/providers/global-sync/provider", () => ({
  useQueryOptions: context.useQueryOptions,
}))

vi.mock("@/app/integrations/sync/query-options", () => ({
  useShellQueryOptions: context.useQueryOptions,
}))

vi.mock("@/platform/query/query-client", () => ({
  queryClient: {
    getQueryData: vi.fn(),
  },
}))

vi.mock("../../workspaces/data/query/project-ensure", () => ({
  ensureLocalProject: api.ensureLocalProject,
}))

vi.mock("@/app/providers/global-sdk/provider", () => ({
  useGlobalSDK: context.useGlobalSDK,
}))

vi.mock("../../../app/providers/global-sdk/provider", () => ({
  useGlobalSDK: context.useGlobalSDK,
}))

vi.mock("@/platform/runtime/platform-provider", () => ({
  usePlatform: context.usePlatform,
}))

vi.mock("@/platform/runtime/platform-provider", () => ({
  usePlatform: context.usePlatform,
}))

import { PageIndex } from "./page-index"

describe("PageIndex", () => {
  beforeEach(() => {
    window.scrollTo = vi.fn()
    api.list.mockReset()
    api.listStatuses.mockReset()
    api.create.mockReset()
    api.transitionStatus.mockReset()
    api.drop.mockReset()
    api.saveStatuses.mockReset()
    api.ensureLocalProject.mockReset()
    api.ensureLocalProject.mockResolvedValue([])
    api.turnIntoWork.mockReset()
    api.turnIntoWork.mockResolvedValue({ proposalId: "proposal_1" })
    api.openWorkGraph.mockReset()
    api.openGlobal.mockReset()
    api.showToast.mockReset()

    api.list.mockResolvedValue([
      {
        id: "page-1",
        title: "Architecture",
        content: "",
        status: "draft",
        visibility: "private",
        version: 1,
        session_id: null,
        directory: "/repo/main",
        source_kind: null,
        source_repo_root: null,
        source_repo_key: null,
        source_branch: null,
        source_path: null,
        base_commit: null,
        base_blob_sha: null,
        base_tree_sha: null,
        last_materialized_commit: null,
        last_materialized_blob_sha: null,
        last_commit_at: null,
        last_commit_author_id: null,
        commit_status: null,
        created_at: "2026-03-25T00:00:00.000Z",
        updated_at: "2026-03-25T00:00:00.000Z",
        project_id: "proj_1",
        project_name: "Project One",
        project_worktree: "/repo/main",
      },
    ])
    api.create.mockResolvedValue({
      id: "page-created",
      title: "Untitled",
      content: "",
      status: "draft",
      visibility: "private",
      version: 1,
      session_id: null,
      directory: "/repo/main",
      source_kind: null,
      source_repo_root: null,
      source_repo_key: null,
      source_branch: null,
      source_path: null,
      base_commit: null,
      base_blob_sha: null,
      base_tree_sha: null,
      last_materialized_commit: null,
      last_materialized_blob_sha: null,
      last_commit_at: null,
      last_commit_author_id: null,
      commit_status: null,
      created_at: "2026-03-25T00:00:00.000Z",
      updated_at: "2026-03-25T00:00:00.000Z",
      project_id: "proj_1",
      project_name: "Project One",
      project_worktree: "/repo/main",
    })
    api.listStatuses.mockResolvedValue([
      { id: "draft", name: "Draft", color: "#999", position: 0, transitions: [] },
    ])
  })

  afterEach(() => {
    cleanup()
  })

  test("loads all pages and filters by provenance without showing project names", async () => {
    const open = vi.fn()
    render(() => (
      <PageIndex
        scope="all"
        projects={[{ id: "proj_1", name: "Project One", worktree: "/repo/main" }]}
        onOpenPage={open}
      />
    ))

    await waitFor(() => expect(api.list).toHaveBeenCalledWith({ scope: "all" }))
    expect(await screen.findByText("Architecture")).toBeTruthy()
    expect(screen.queryByText("Project One")).toBeNull()
    expect(screen.getByText("Workspace page")).toBeTruthy()

    const sel = screen.getByDisplayValue("All pages") as HTMLSelectElement
    sel.value = "workspace:/repo/main"
    fireEvent.input(sel)

    expect(api.list).toHaveBeenCalledTimes(1)
    await screen.findByText("Architecture")

    fireEvent.click(screen.getByText("Architecture"))
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "page-1" }))
  })

  test("creates a page in the active workspace without asking for a bucket", async () => {
    const open = vi.fn()
    render(() => (
      <PageIndex
        scope="project"
        directory="/repo/main"
        projects={[{ id: "proj_1", name: "Project One", worktree: "/repo/main" }]}
        onOpenPage={open}
      />
    ))

    fireEvent.click(await screen.findByRole("button", { name: "Create page" }))

    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({
        title: "Untitled",
        project_id: "proj_1",
        directory: "/repo/main",
      }),
    )
    expect(api.ensureLocalProject).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:4096",
      request: undefined,
      directory: "/repo/main",
      projectsQuery: {
        queryKey: ["projects"],
        queryFn: expect.any(Function),
      },
    })
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "page-created" }))
  })

  const TURN_LABEL = "Turn current revision into WorkGraph work"

  function boundPage(overrides: Record<string, unknown> = {}) {
    return {
      id: "page-1",
      title: "Architecture",
      content: "editor text that must never be sent",
      status: "draft",
      visibility: "private",
      version: 3,
      session_id: null,
      directory: "/repo/main",
      source_kind: null,
      source_repo_root: null,
      source_repo_key: null,
      source_branch: null,
      source_path: null,
      base_commit: null,
      base_blob_sha: null,
      base_tree_sha: null,
      last_materialized_commit: null,
      last_materialized_blob_sha: null,
      last_commit_at: null,
      last_commit_author_id: null,
      commit_status: null,
      created_at: "2026-03-25T00:00:00.000Z",
      updated_at: "2026-03-25T00:00:00.000Z",
      project_id: "proj_1",
      project_name: "Project One",
      project_worktree: "/repo/main",
      document_id: "document_1",
      document_revision_id: "revision_1",
      ...overrides,
    }
  }

  async function openRowMenu() {
    const trigger = await screen.findByRole("button", { name: "Page actions" })
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    await screen.findByRole("menu")
  }

  test("dispatches only the exact persisted revision locator and opens Needs you on success", async () => {
    api.list.mockResolvedValue([boundPage()])
    render(() => (
      <PageIndex
        scope="project"
        directory="/repo/main"
        projects={[{ id: "proj_1", name: "Project One", worktree: "/repo/main" }]}
        onOpenPage={vi.fn()}
      />
    ))
    await screen.findByText("Architecture")
    await openRowMenu()

    fireEvent.keyDown(screen.getByRole("menuitem", { name: TURN_LABEL }), { key: "Enter" })

    await waitFor(() => expect(api.turnIntoWork).toHaveBeenCalledTimes(1))
    // Only the persisted revision ids travel — never editor text/content.
    expect(api.turnIntoWork).toHaveBeenCalledWith({
      projectId: "proj_1",
      documentId: "document_1",
      revisionId: "revision_1",
      directory: "/repo/main",
    })
    await waitFor(() => expect(api.openWorkGraph).toHaveBeenCalledTimes(1))
    expect(api.openGlobal).toHaveBeenCalledWith("workgraph-attention")
    expect(api.showToast).not.toHaveBeenCalled()
  })

  test("surfaces the exact typed handoff error and does not navigate", async () => {
    api.list.mockResolvedValue([boundPage()])
    api.turnIntoWork.mockRejectedValue(new Error("This Docs document is connected to more than one Stream"))
    render(() => (
      <PageIndex
        scope="project"
        directory="/repo/main"
        projects={[{ id: "proj_1", name: "Project One", worktree: "/repo/main" }]}
        onOpenPage={vi.fn()}
      />
    ))
    await screen.findByText("Architecture")
    await openRowMenu()

    fireEvent.keyDown(screen.getByRole("menuitem", { name: TURN_LABEL }), { key: "Enter" })

    await waitFor(() =>
      expect(api.showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "This Docs document is connected to more than one Stream",
          variant: "error",
        }),
      ),
    )
    expect(api.openWorkGraph).not.toHaveBeenCalled()
    expect(api.openGlobal).not.toHaveBeenCalled()
  })

  test("omits the action when the page has no durable revision identity", async () => {
    api.list.mockResolvedValue([boundPage({ document_revision_id: null })])
    render(() => (
      <PageIndex
        scope="project"
        directory="/repo/main"
        projects={[{ id: "proj_1", name: "Project One", worktree: "/repo/main" }]}
        onOpenPage={vi.fn()}
      />
    ))
    await screen.findByText("Architecture")
    await openRowMenu()

    expect(screen.queryByRole("menuitem", { name: TURN_LABEL })).toBeNull()
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy()
  })
})
