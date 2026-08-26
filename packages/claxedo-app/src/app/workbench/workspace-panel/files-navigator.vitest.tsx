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
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { createSignal } from "solid-js"

const h = vi.hoisted(() => ({
  treeExpand: vi.fn(),
  treeList: vi.fn(),
  fileRead: vi.fn(async ({ path }: { path: string }) => ({ data: { type: "text", content: `content:${path}` } })),
}))

// Partial mock: `@/ui/icons/config` re-exports `iconLibrary` from this module and
// `ClaxedoIcon` reads it, so replacing the module wholesale breaks every render
// that reaches a Claxedo glyph. Keep the real exports and override only `Icon`.
vi.mock("@opencode-ai/ui/icon", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Icon: (props: any) => <span data-icon={props.name} />,
}))
vi.mock("@opencode-ai/ui/spinner", () => ({ Spinner: () => <span data-testid="spinner" /> }))
vi.mock("@opencode-ai/ui/file-icon", () => ({ FileIcon: () => <span data-testid="file-icon" /> }))
vi.mock("@/app/workbench/controls/file-tree", () => ({
  default: (props: any) => (
    <div data-testid="file-tree" data-allowed={(props.allowed ?? []).join(",")}>
      <button
        data-testid="mock-file-row"
        onPointerEnter={() => props.onFilePointerEnter?.({ path: "src/hovered.ts", type: "file" })}
        onPointerLeave={() => props.onFilePointerLeave?.({ path: "src/hovered.ts", type: "file" })}
      />
    </div>
  ),
}))
vi.mock("@/platform/runtime/session-switch", () => ({
  fastSessionSwitchAnyQuietDelay: () => 0,
}))

let statusFiles: Array<{ path: string; status: string }> = []
let searchHits: string[] = []
let statusCalls = 0
let watcher: ((event: { details: { type: string } }) => void) | undefined

vi.mock("@/app/providers/sdk/sdk", () => ({
  useSDK: () => ({
    url: "http://opencode.test",
    directory: "/work/repo",
    workspaceId: "workspace-1",
    client: { file: {
      read: h.fileRead,
      status: async () => {
        statusCalls += 1
        return { data: statusFiles }
      },
    } },
    event: { listen: (listener: typeof watcher) => {
      watcher = listener
      return () => {}
    } },
  }),
}))

vi.mock("@/app/providers/file", () => ({
  useFile: () => ({
    ready: () => true,
    searchFiles: async () => searchHits,
    tree: {
      list: h.treeList,
      state: () => ({ loaded: true, loading: false }),
      children: () => [],
      expand: h.treeExpand,
    },
  }),
}))

import { WorkspaceFilesNavigator } from "./files-navigator"
import { queryClient } from "@/platform/query/query-client"

const renderNavigator = (view: () => ReturnType<typeof WorkspaceFilesNavigator>) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(() => <QueryClientProvider client={client}>{view()}</QueryClientProvider>)
}

afterEach(() => {
  cleanup()
  statusFiles = []
  searchHits = []
  statusCalls = 0
  watcher = undefined
  h.treeExpand.mockClear()
  h.treeList.mockClear()
  h.fileRead.mockClear()
  queryClient.clear()
  document.body.innerHTML = ""
})

describe("WorkspaceFilesNavigator (changes mode)", () => {
  test("renders one changed-file row per status entry with its filename", async () => {
    statusFiles = [
      { path: "src/app.ts", status: "added" },
      { path: "README.md", status: "modified" },
    ]
    const view = renderNavigator(() => (
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
    const view = renderNavigator(() => (
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
    const view = renderNavigator(() => (
      <WorkspaceFilesNavigator mode="changes" active onFileClick={onFileClick} />
    ))
    await waitFor(() => expect(view.getByText("app.ts")).toBeTruthy())

    fireEvent.click(view.getByText("app.ts"))
    expect(onFileClick).toHaveBeenCalledWith("src/app.ts", "review")
  })

  test("shows the empty state when there are no changed files", async () => {
    statusFiles = []
    const view = renderNavigator(() => (
      <WorkspaceFilesNavigator mode="changes" active onFileClick={() => {}} />
    ))
    await waitFor(() => expect(view.getByText("No changed files")).toBeTruthy())
  })

  test("does not refetch from a delayed watcher event after the retained panel becomes inactive", async () => {
    const [active, setActive] = createSignal(true)
    renderNavigator(() => (
      <WorkspaceFilesNavigator mode="changes" active={active()} onFileClick={() => {}} />
    ))
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0))
    const before = statusCalls
    watcher?.({ details: { type: "file.watcher.updated" } })
    setActive(false)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(statusCalls).toBe(before)
  })
})

describe("WorkspaceFilesNavigator (files mode)", () => {
  test("warms the canonical file request on deliberate hover without opening a surface", async () => {
    const view = renderNavigator(() => (
      <WorkspaceFilesNavigator mode="files" active onFileClick={() => {}} />
    ))

    fireEvent.pointerEnter(view.getByTestId("mock-file-row"))
    await waitFor(() => expect(h.fileRead).toHaveBeenCalledWith({ path: "src/hovered.ts" }), { timeout: 1_000 })
    await waitFor(() => {
      const navigator = view.getByTestId("workspace-files-navigator")
      expect(navigator.dataset.filePrefetchPath).toBe("src/hovered.ts")
      expect(navigator.dataset.filePrefetchState).toBe("ready")
    })
    expect(view.queryByTestId("tab-file-root")).toBeNull()
  })

  test("cancels hover prefetch when the retained navigator becomes inactive", async () => {
    const [active, setActive] = createSignal(true)
    const view = renderNavigator(() => (
      <WorkspaceFilesNavigator mode="files" active={active()} onFileClick={() => {}} />
    ))

    fireEvent.pointerEnter(view.getByTestId("mock-file-row"))
    setActive(false)
    await new Promise((resolve) => setTimeout(resolve, 180))

    expect(h.fileRead).not.toHaveBeenCalled()
    expect(view.getByTestId("workspace-files-navigator").dataset.filePrefetchState).not.toBe("ready")
  })

  test("does not hydrate or reveal the retained tree while the panel is inactive", async () => {
    renderNavigator(() => (
      <WorkspaceFilesNavigator mode="files" active={false} activePath="src/deep/file.ts" onFileClick={() => {}} />
    ))

    await Promise.resolve()
    await Promise.resolve()

    expect(h.treeList).not.toHaveBeenCalled()
    expect(h.treeExpand).not.toHaveBeenCalled()
  })

  test("reveals an active file after its tree row mounts", async () => {
    const view = renderNavigator(() => (
      <WorkspaceFilesNavigator mode="files" active activePath="src/deep/file.ts" onFileClick={() => {}} />
    ))

    await waitFor(() => {
      expect(h.treeExpand).toHaveBeenCalledWith("src")
      expect(h.treeExpand).toHaveBeenCalledWith("src/deep")
    })

    const row = document.createElement("button")
    row.dataset.fileTreePath = "src/deep/file.ts"
    row.scrollIntoView = vi.fn()
    view.getByTestId("file-tree").append(row)

    await waitFor(() => expect(row.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" }))
  })
})
