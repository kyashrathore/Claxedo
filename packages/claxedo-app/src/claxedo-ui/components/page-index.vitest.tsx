import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { PageIndex } from "./page-index"

const list = vi.fn()
const listStatuses = vi.fn()
const transitionStatus = vi.fn()
const drop = vi.fn()
const saveStatuses = vi.fn()

vi.mock("../../utils/pages-api", () => ({
  pagesApi: {
    list,
    listStatuses,
    create: vi.fn(),
    transitionStatus,
    delete: drop,
    saveStatuses,
  },
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ show: vi.fn() }),
}))

vi.mock("@opencode-ai/ui/toast", () => ({
  showToast: vi.fn(),
}))

describe("PageIndex", () => {
  beforeEach(() => {
    list.mockReset()
    listStatuses.mockReset()
    transitionStatus.mockReset()
    drop.mockReset()
    saveStatuses.mockReset()

    list.mockResolvedValue([
      {
        id: "page-1",
        title: "Architecture",
        content: "",
        status: "draft",
        session_id: null,
        file_path: null,
        directory: "/repo/main",
        created_at: "2026-03-25T00:00:00.000Z",
        updated_at: "2026-03-25T00:00:00.000Z",
        project_id: "proj_1",
        project_name: "Project One",
        project_worktree: "/repo/main",
      },
    ])
    listStatuses.mockResolvedValue([
      { id: "draft", name: "Draft", color: "#999", position: 0, transitions: [] },
    ])
  })

  afterEach(() => {
    cleanup()
  })

  test("loads all pages in global scope and lets users filter by project", async () => {
    const open = vi.fn()
    render(() => (
      <PageIndex
        scope="all"
        projects={[{ id: "proj_1", name: "Project One", worktree: "/repo/main" }]}
        onOpenPage={open}
      />
    ))

    await waitFor(() => expect(list).toHaveBeenCalledWith({ scope: "all" }))
    expect(await screen.findByText("Architecture")).toBeTruthy()
    expect(screen.getByText("Project One")).toBeTruthy()

    const sel = screen.getByDisplayValue("All pages") as HTMLSelectElement
    sel.value = "proj_1"
    fireEvent.input(sel)

    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ scope: "project", project_id: "proj_1" }))

    fireEvent.click(screen.getByText("Architecture"))
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "page-1" }))
  })
})
