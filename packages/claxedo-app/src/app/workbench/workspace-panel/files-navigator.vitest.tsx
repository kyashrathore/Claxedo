/**
 * WorkspaceFilesNavigator — component integration tests.
 *
 * Exercises the changed-file list rendering, the filter-input branching
 * (search vs changed-file filter), the empty states, and the file-click
 * intent (review in changes mode). The SDK and file contexts are mocked so
 * the stateful branching runs without a live backend.
 */

import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"

vi.mock("@opencode-ai/ui/icon", () => ({ Icon: (props: any) => <span data-icon={props.name} /> }))
vi.mock("@opencode-ai/ui/spinner", () => ({ Spinner: () => <span data-testid="spinner" /> }))
vi.mock("@opencode-ai/ui/file-icon", () => ({ FileIcon: () => <span data-testid="file-icon" /> }))
vi.mock("@/app/workbench/controls/file-tree", () => ({
  default: (props: any) => <div data-testid="file-tree" data-allowed={(props.allowed ?? []).join(",")} />,
}))
vi.mock("@/platform/runtime/session-switch", () => ({
  fastSessionSwitchAnyQuietDelay: () => 0,
}))

let statusFiles: Array<{ path: string; status: string }> = []
let searchHits: string[] = []

vi.mock("@/app/providers/sdk/sdk", () => ({
  useSDK: () => ({
    client: { file: { status: async () => ({ data: statusFiles }) } },
    event: { listen: () => () => {} },
  }),
}))

vi.mock("@/app/providers/file", () => ({
  useFile: () => ({
    ready: () => true,
    searchFiles: async () => searchHits,
    tree: {
      list: () => {},
      state: () => ({ loaded: true, loading: false }),
      children: () => [],
    },
  }),
}))

import { WorkspaceFilesNavigator } from "./files-navigator"

afterEach(() => {
  cleanup()
  statusFiles = []
  searchHits = []
  document.body.innerHTML = ""
})

describe("WorkspaceFilesNavigator (changes mode)", () => {
  test("renders one changed-file row per status entry with its filename", async () => {
    statusFiles = [
      { path: "src/app.ts", status: "added" },
      { path: "README.md", status: "modified" },
    ]
    const view = render(() => (
      <WorkspaceFilesNavigator mode="changes" active onFileClick={() => {}} />
    ))
    await waitFor(() => expect(view.getByTestId("workspace-changed-file-list")).toBeTruthy())
    expect(view.getByText("app.ts")).toBeTruthy()
    expect(view.getByText("README.md")).toBeTruthy()
  })

  test("filter input narrows the changed-file list to matching paths", async () => {
    statusFiles = [
      { path: "src/app.ts", status: "added" },
      { path: "README.md", status: "modified" },
    ]
    const view = render(() => (
      <WorkspaceFilesNavigator mode="changes" active onFileClick={() => {}} />
    ))
    await waitFor(() => expect(view.getByText("app.ts")).toBeTruthy())

    fireEvent.input(view.getByPlaceholderText("Filter changes..."), { target: { value: "readme" } })

    await waitFor(() => expect(view.queryByText("app.ts")).toBeNull())
    expect(view.getByText("README.md")).toBeTruthy()
  })

  test("clicking a changed file requests it with the review intent", async () => {
    statusFiles = [{ path: "src/app.ts", status: "added" }]
    const onFileClick = vi.fn()
    const view = render(() => (
      <WorkspaceFilesNavigator mode="changes" active onFileClick={onFileClick} />
    ))
    await waitFor(() => expect(view.getByText("app.ts")).toBeTruthy())

    fireEvent.click(view.getByText("app.ts"))
    expect(onFileClick).toHaveBeenCalledWith("src/app.ts", "review")
  })

  test("shows the empty state when there are no changed files", async () => {
    statusFiles = []
    const view = render(() => (
      <WorkspaceFilesNavigator mode="changes" active onFileClick={() => {}} />
    ))
    await waitFor(() => expect(view.getByText("No changed files")).toBeTruthy())
  })
})
