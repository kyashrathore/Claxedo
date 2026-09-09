/**
 * WorkspaceFilesNavigator — component integration tests.
 *
 * Exercises the hover prefetch, the active-file reveal, and the inactive
 * retention gates. The SDK and file contexts are mocked so the stateful
 * branching runs without a live backend.
 */

import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { Suspense, createSignal } from "solid-js"

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
vi.mock("@/app/workbench/controls/file-tree", () => ({
  default: (props: any) => (
    <div data-testid="file-tree" data-allowed={(props.allowed ?? []).join(",")}>
      <button
        data-testid="mock-file-row"
        onPointerEnter={() => props.onFilePointerEnter?.({ path: "src/hovered.ts", type: "file" })}
        onPointerLeave={() => props.onFilePointerLeave?.({ path: "src/hovered.ts", type: "file" })}
        onClick={() => props.onFileClick?.({ path: "src/hovered.ts", type: "file" })}
      />
    </div>
  ),
}))
vi.mock("@/platform/runtime/session-switch", () => ({
  fastSessionSwitchAnyQuietDelay: () => 0,
}))

let statusFiles: Array<{ path: string; status: string }> = []
let searchHits: string[] = []
let searchNeverSettles = false
let statusCalls = 0

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
  }),
}))

vi.mock("@/app/providers/file", () => ({
  useFile: () => ({
    ready: () => true,
    searchFiles: () => (searchNeverSettles ? new Promise<string[]>(() => {}) : Promise.resolve(searchHits)),
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

const navigatorClients: QueryClient[] = []

const renderNavigator = (view: () => ReturnType<typeof WorkspaceFilesNavigator>) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  navigatorClients.push(client)
  return { ...render(() => <QueryClientProvider client={client}>{view()}</QueryClientProvider>), client }
}

afterEach(() => {
  cleanup()
  for (const client of navigatorClients.splice(0)) client.clear()
  vi.useRealTimers()
  statusFiles = []
  searchHits = []
  searchNeverSettles = false
  statusCalls = 0
  h.treeExpand.mockClear()
  h.treeList.mockClear()
  h.fileRead.mockClear()
  queryClient.clear()
  document.body.innerHTML = ""
})

describe("WorkspaceFilesNavigator", () => {
  test("clicking a tree file requests it by path", async () => {
    const onFileClick = vi.fn()
    const view = renderNavigator(() => <WorkspaceFilesNavigator active onFileClick={onFileClick} />)

    fireEvent.click(view.getByTestId("mock-file-row"))
    expect(onFileClick).toHaveBeenCalledWith("src/hovered.ts")
  })

  test("search narrows the tree to the search hits and reports an empty search", async () => {
    searchHits = ["src/app.ts"]
    const view = renderNavigator(() => <WorkspaceFilesNavigator active onFileClick={() => {}} />)
    expect(view.getByTestId("file-tree").dataset.allowed).toBe("")

    fireEvent.input(view.getByPlaceholderText("Search files..."), { target: { value: "app" } })
    await waitFor(() => expect(view.getByTestId("file-tree").dataset.allowed).toBe("src/app.ts"))

    searchHits = []
    fireEvent.input(view.getByPlaceholderText("Search files..."), { target: { value: "missing" } })
    await waitFor(() => expect(view.getByText("No files found")).toBeTruthy())
    expect(view.getByTestId("file-tree")).toBeTruthy()
  })

  test("does not refetch an invalidated status query while the retained panel is inactive", async () => {
    const [active, setActive] = createSignal(true)
    const view = renderNavigator(() => <WorkspaceFilesNavigator active={active()} onFileClick={() => {}} />)
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0))
    const before = statusCalls
    setActive(false)
    await view.client.invalidateQueries()
    expect(statusCalls).toBe(before)
  })

  test("warms the canonical file request on deliberate hover without opening a surface", async () => {
    vi.useFakeTimers()
    const view = renderNavigator(() => <WorkspaceFilesNavigator active onFileClick={() => {}} />)

    fireEvent.pointerEnter(view.getByTestId("mock-file-row"))
    await vi.advanceTimersByTimeAsync(119)
    expect(h.fileRead).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(h.fileRead).toHaveBeenCalledWith({ path: "src/hovered.ts" })
    await waitFor(() => {
      const navigator = view.getByTestId("workspace-files-navigator")
      expect(navigator.dataset.filePrefetchPath).toBe("src/hovered.ts")
      expect(navigator.dataset.filePrefetchState).toBe("ready")
    })
    expect(view.queryByTestId("tab-file-root")).toBeNull()
  })

  test("cancels hover prefetch when the retained navigator becomes inactive", async () => {
    vi.useFakeTimers()
    const [active, setActive] = createSignal(true)
    const view = renderNavigator(() => <WorkspaceFilesNavigator active={active()} onFileClick={() => {}} />)

    fireEvent.pointerEnter(view.getByTestId("mock-file-row"))
    setActive(false)
    await vi.advanceTimersByTimeAsync(120)

    expect(h.fileRead).not.toHaveBeenCalled()
    expect(view.getByTestId("workspace-files-navigator").dataset.filePrefetchState).not.toBe("ready")
  })

  test("does not hydrate or reveal the retained tree while the panel is inactive", async () => {
    renderNavigator(() => (
      <WorkspaceFilesNavigator active={false} activePath="src/deep/file.ts" onFileClick={() => {}} />
    ))

    await Promise.resolve()
    await Promise.resolve()

    expect(h.treeList).not.toHaveBeenCalled()
    expect(h.treeExpand).not.toHaveBeenCalled()
  })

  test("reveals an active file after its tree row mounts", async () => {
    const view = renderNavigator(() => (
      <WorkspaceFilesNavigator active activePath="src/deep/file.ts" onFileClick={() => {}} />
    ))

    await waitFor(() => {
      expect(h.treeExpand).toHaveBeenCalledWith("src")
      expect(h.treeExpand).toHaveBeenCalledWith("src/deep")
    })

    const row = document.createElement("button")
    row.dataset.fileTreePath = "src/deep/file.ts"
    const scrollIntoView = vi.fn()
    row.scrollIntoView = scrollIntoView
    view.getByTestId("file-tree").append(row)

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" }))
  })

  test("a pending search does not suspend the enclosing boundary", async () => {
    searchNeverSettles = true
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    navigatorClients.push(client)
    // The only boundary above this panel is app.tsx's, which wraps the whole
    // shell: suspending here replaces the entire window with the boot fallback.
    const view = render(() => (
      <QueryClientProvider client={client}>
        <Suspense fallback={<div data-testid="shell-fallback" />}>
          <WorkspaceFilesNavigator active onFileClick={() => {}} />
        </Suspense>
      </QueryClientProvider>
    ))

    fireEvent.input(view.getByPlaceholderText("Search files..."), { target: { value: "app" } })
    await waitFor(() => expect(view.getByTestId("spinner")).toBeTruthy())

    expect(view.queryByTestId("shell-fallback")).toBeNull()
    expect(view.queryByTestId("workspace-files-navigator")).toBeTruthy()
  })
})
