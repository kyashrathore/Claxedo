import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Show, createSignal, type Accessor } from "solid-js"
import { ClaxedoStateProvider, useClaxedoState, type ClaxedoStateApi } from "../state/index"
import { emptyClaxedoState } from "../state/persistence"
import { ProcessPaneProvider, useWorkspaceProcessPane } from "./process-pane"
import { processPaneInstanceCount } from "./process-pane-registry"

type FakePane = { id: number; directory: string; isOpen: Accessor<boolean> }

const feature = vi.hoisted(() => ({
  inits: 0,
  disposed: [] as string[],
}))

vi.mock("@/features/processes/providers", async () => {
  const solid = await vi.importActual<typeof import("solid-js")>("solid-js")
  const ctx = solid.createContext<FakePane>()
  return {
    ProcessPaneProvider: (props: { directory: string; isOpen: Accessor<boolean>; children: unknown }) => {
      feature.inits += 1
      const pane: FakePane = { id: feature.inits, directory: props.directory, isOpen: props.isOpen }
      solid.onCleanup(() => feature.disposed.push(props.directory))
      return solid.createComponent(ctx.Provider, {
        value: pane,
        get children() {
          return props.children
        },
      })
    },
    useProcessPane: () => {
      const value = solid.useContext(ctx)
      if (!value) throw new Error("fake ProcessPane context missing")
      return value
    },
    createProcessOwnership: () => ({}),
    createTerminalTabOps: () => ({}),
  }
})

vi.mock("@/app/providers/sdk/sdk", () => ({
  useSDK: () => ({ directory: "/repo/main", workspace: () => undefined }),
}))

vi.mock("@/platform/runtime/platform-provider", () => ({
  usePlatform: () => ({ fetch }),
}))

vi.mock("@/platform/settings/provider", () => ({
  useSettings: () => ({ appearance: { navigatorPlacement: () => "panel" } }),
}))

vi.mock("@/features/terminal/providers/provider", () => ({
  useOptionalTerminal: () => undefined,
}))

vi.mock("@/app/integrations/claxedo-events", () => ({
  useClaxedoEventsOptional: () => undefined,
}))

beforeEach(() => {
  feature.inits = 0
  feature.disposed = []
})

afterEach(() => {
  cleanup()
})

function isFakePane(value: unknown): value is FakePane {
  return typeof value === "object" && value !== null && "id" in value && "directory" in value && "isOpen" in value
}

function Consumer(props: { onPane: (pane: FakePane) => void }) {
  const pane: unknown = useWorkspaceProcessPane()
  if (!isFakePane(pane)) throw new Error("the wrapper did not provide the fake feature pane")
  props.onPane(pane)
  return null
}

function Probe(props: { onState: (state: ClaxedoStateApi) => void }) {
  props.onState(useClaxedoState())
  return null
}

describe("process pane registry", () => {
  test("two consumers of one directory share one instance, released when the last one leaves", () => {
    const [first, setFirst] = createSignal(true)
    const [second, setSecond] = createSignal(true)
    const panes: FakePane[] = []
    render(() => (
      <ClaxedoStateProvider initialState={emptyClaxedoState()}>
        <Show when={first()}>
          <ProcessPaneProvider directory="/repo/main">
            <Consumer onPane={(pane) => panes.push(pane)} />
          </ProcessPaneProvider>
        </Show>
        <Show when={second()}>
          <ProcessPaneProvider directory="/repo/main">
            <Consumer onPane={(pane) => panes.push(pane)} />
          </ProcessPaneProvider>
        </Show>
      </ClaxedoStateProvider>
    ))

    expect(feature.inits).toBe(1)
    expect(panes).toHaveLength(2)
    expect(panes[0]).toBe(panes[1])
    expect(processPaneInstanceCount()).toBe(1)

    setFirst(false)
    expect(feature.disposed).toEqual([])
    expect(processPaneInstanceCount()).toBe(1)

    setSecond(false)
    expect(feature.disposed).toEqual(["/repo/main"])
    expect(processPaneInstanceCount()).toBe(0)
  })

  test("different directories get their own instances", () => {
    const panes: FakePane[] = []
    render(() => (
      <ClaxedoStateProvider initialState={emptyClaxedoState()}>
        <ProcessPaneProvider directory="/repo/a">
          <Consumer onPane={(pane) => panes.push(pane)} />
        </ProcessPaneProvider>
        <ProcessPaneProvider directory="/repo/b">
          <Consumer onPane={(pane) => panes.push(pane)} />
        </ProcessPaneProvider>
      </ClaxedoStateProvider>
    ))

    expect(feature.inits).toBe(2)
    expect(panes[0]?.directory).toBe("/repo/a")
    expect(panes[1]?.directory).toBe("/repo/b")
    expect(processPaneInstanceCount()).toBe(2)
  })

  test("the instance is open while any holder shows the list", () => {
    const [sidebarShows, setSidebarShows] = createSignal(false)
    const [sidebarMounted, setSidebarMounted] = createSignal(true)
    const panes: FakePane[] = []
    let state: ClaxedoStateApi | undefined
    render(() => (
      <ClaxedoStateProvider initialState={emptyClaxedoState()}>
        <Probe onState={(api) => { state = api }} />
        <ProcessPaneProvider directory="/repo/main">
          <Consumer onPane={(pane) => panes.push(pane)} />
        </ProcessPaneProvider>
        <Show when={sidebarMounted()}>
          <ProcessPaneProvider directory="/repo/main" isOpen={sidebarShows}>
            <Consumer onPane={(pane) => panes.push(pane)} />
          </ProcessPaneProvider>
        </Show>
      </ClaxedoStateProvider>
    ))

    const pane = panes[0]
    expect(pane.isOpen()).toBe(false)

    setSidebarShows(true)
    expect(pane.isOpen()).toBe(true)

    setSidebarMounted(false)
    expect(pane.isOpen()).toBe(false)

    state!.workspacePanel.open({ workspaceDir: "/repo/main", targetPaneId: "pane-1", navigator: "processes" })
    expect(pane.isOpen()).toBe(true)

    state!.workspacePanel.open({ workspaceDir: "/repo/other", targetPaneId: "pane-1", navigator: "processes" })
    expect(pane.isOpen()).toBe(false)
  })

  test("the wrapper falls back to the scope's directory", () => {
    const panes: FakePane[] = []
    render(() => (
      <ClaxedoStateProvider initialState={emptyClaxedoState()}>
        <ProcessPaneProvider>
          <Consumer onPane={(pane) => panes.push(pane)} />
        </ProcessPaneProvider>
      </ClaxedoStateProvider>
    ))

    expect(panes[0]?.directory).toBe("/repo/main")
  })
})
