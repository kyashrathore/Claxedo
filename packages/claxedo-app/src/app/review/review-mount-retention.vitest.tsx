import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createSignal, type JSX } from "solid-js"
import { ClaxedoStateProvider, useClaxedoState } from "../workbench/state/provider"
import { emptyClaxedoState } from "../workbench/state/persistence"
import { WorkspacePanelBody } from "../workbench/rail/workspace-panel-body"
import { warmWorkspacePanelReview } from "../workbench/rail/workspace-panel-review-load"

const runtime = vi.hoisted(() => ({ ready: () => true, mounts: 0 }))
vi.mock("@/features/workspaces/data/workspace-connection", () => ({
  isWorkspaceReady: () => runtime.ready(), workspaceOffline: () => undefined,
}))
vi.mock("@/features/session/ui/components/session-pane-scope", () => ({
  SessionPaneScope: (props: { children: JSX.Element }) => props.children,
}))
vi.mock("@/app/workbench/context/process-pane", () => ({
  ProcessPaneProvider: (props: { children: JSX.Element }) => props.children,
  useWorkspaceProcessPane: () => ({}),
}))
vi.mock("@/app/workbench/workspace-panel/files-navigator", () => ({ WorkspaceFilesNavigator: () => null }))
vi.mock("@/features/processes/ui", () => ({ WorkspaceProcessesNavigator: () => null }))
vi.mock("@/platform/settings/provider", () => ({ useSettings: () => ({ appearance: { navigatorSide: () => "right" } }) }))
vi.mock("@/platform/runtime/platform-provider", () => ({ usePlatform: () => ({ fetch }) }))
vi.mock("@/app/workbench/review/review-workspace", () => ({
  ReviewWorkspace: () => { runtime.mounts += 1; return <div data-testid="review-body" /> },
}))

afterEach(() => { cleanup(); runtime.mounts = 0 })

function mountPanel(ready: boolean) {
  const [available, setAvailable] = createSignal(ready)
  runtime.ready = available
  const directory = "workspace:ws_review_retention"
  const Body = () => {
    const state = useClaxedoState()
    state.workspacePanel.open("review", { workspaceDir: directory })
    return <WorkspacePanelBody mode="review" state={state.workspacePanel.state()} directory={directory}
      active={() => true} hydrated={() => true} focusedWorkspaceDir={() => directory} />
  }
  const view = render(() => <ClaxedoStateProvider initialState={emptyClaxedoState()}><Body /></ClaxedoStateProvider>)
  return { view, setAvailable }
}

describe("WorkspacePanelBody review retention", () => {
  test("mounts the warmed wrapper synchronously and preserves it through reconnect", async () => {
    await warmWorkspacePanelReview()
    const { view, setAvailable } = mountPanel(true)
    const body = view.getByTestId("review-body")
    expect(runtime.mounts).toBe(1)
    expect(body.parentElement!.style.visibility).toBe("visible")

    setAvailable(false)
    expect(view.getByTestId("workspace-review-pending")).toBeTruthy()
    expect(view.getByTestId("review-body")).toBe(body)
    expect(body.parentElement!.style.visibility).toBe("hidden")

    setAvailable(true)
    expect(view.queryByTestId("workspace-review-pending")).toBeNull()
    expect(view.getByTestId("review-body")).toBe(body)
    expect(body.parentElement!.style.visibility).toBe("visible")
    expect(runtime.mounts).toBe(1)
  })

  test("defers a new workspace body until its own connection becomes ready", async () => {
    const { view, setAvailable } = mountPanel(false)
    expect(view.queryByTestId("review-body")).toBeNull()
    expect(view.getByTestId("workspace-review-pending")).toBeTruthy()
    setAvailable(true)
    await waitFor(() => expect(view.getByTestId("review-body")).toBeTruthy())
    expect(runtime.mounts).toBe(1)
  })
})
