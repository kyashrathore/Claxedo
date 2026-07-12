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
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ show: vi.fn() }),
}))

vi.mock("@opencode-ai/ui/toast", () => ({
  showToast: vi.fn(),
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
    api.list.mockReset()
    api.listStatuses.mockReset()
    api.create.mockReset()
    api.transitionStatus.mockReset()
    api.drop.mockReset()
    api.saveStatuses.mockReset()
    api.ensureLocalProject.mockReset()
    api.ensureLocalProject.mockResolvedValue([])

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
})
