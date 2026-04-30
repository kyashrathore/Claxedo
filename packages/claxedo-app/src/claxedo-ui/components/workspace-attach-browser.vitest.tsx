import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render } from "@solidjs/testing-library"

vi.mock("@opencode-ai/ui/icon", () => ({
  Icon: () => <span data-testid="icon" />,
}))

import { WorkspaceAttachBrowser } from "./workspace-attach-browser"

afterEach(() => {
  cleanup()
})

describe("WorkspaceAttachBrowser", () => {
  test("filters and selects workspaces", async () => {
    const onSelect = vi.fn()
    const { getByPlaceholderText, getByText, queryByText } = render(() => (
      <WorkspaceAttachBrowser
        projects={[
          { id: "p-1", name: "Alpha", worktree: "/repo/main" },
          { id: "p-2", name: "Beta", worktree: "/other/main" },
        ]}
        items={[
          {
            id: "/repo/main",
            name: "main",
            directory: "/repo/main",
            projectId: "p-1",
            projectName: "Alpha",
            isMain: true,
            isCloud: false,
          },
          {
            id: "/other/feature",
            name: "feature-auth",
            directory: "/other/feature",
            projectId: "p-2",
            projectName: "Beta",
            isMain: false,
            isCloud: false,
          },
        ]}
        currentDirectory="/repo/main"
        onSelect={onSelect}
        onCreateProject={vi.fn()}
      />
    ))

    fireEvent.input(getByPlaceholderText("Filter workspaces..."), {
      currentTarget: { value: "feature" },
      target: { value: "feature" },
    })

    expect(queryByText("main")).toBeNull()
    fireEvent.click(getByText("feature-auth"))
    expect(onSelect).toHaveBeenCalledWith("p-2", "/other/feature")
  })

  test("invokes create callback for the chosen project group", () => {
    const onCreateProject = vi.fn()
    const { getAllByLabelText } = render(() => (
      <WorkspaceAttachBrowser
        projects={[{ id: "p-1", name: "Alpha", worktree: "/repo/main" }]}
        items={[
          {
            id: "/repo/main",
            name: "main",
            directory: "/repo/main",
            projectId: "p-1",
            projectName: "Alpha",
            isMain: true,
            isCloud: false,
          },
        ]}
        onSelect={vi.fn()}
        onCreateProject={onCreateProject}
      />
    ))

    fireEvent.click(getAllByLabelText("Add workspace to Alpha")[0]!)
    expect(onCreateProject).toHaveBeenCalledWith("p-1", "Alpha")
  })
})
