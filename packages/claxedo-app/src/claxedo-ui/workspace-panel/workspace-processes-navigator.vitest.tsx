/**
 * WorkspaceProcessesNavigator — component integration tests.
 *
 * Drives the start/stop/restart button-visibility matrix per Process.Status,
 * the read-only (canMutate=false) surface, and the add-process dialog gating.
 * The process-pane context and dialog host are mocked so the branching is
 * exercised without a live SDK.
 */

import { afterEach, describe, expect, test, vi } from "vitest"
import { render, cleanup, fireEvent } from "@solidjs/testing-library"
import type { Process } from "@claxedo/process/process"

vi.mock("@opencode-ai/ui/icon", () => ({
  Icon: (props: any) => <span data-icon={props.name} />,
}))

vi.mock("@opencode-ai/ui/icon-button", () => ({
  IconButton: (props: any) => (
    <button data-icon={props.icon} aria-label={props["aria-label"]} onClick={props.onClick} />
  ),
}))

vi.mock("@opencode-ai/ui/tooltip", () => ({
  Tooltip: (props: any) => <>{props.children}</>,
}))

vi.mock("../components/add-process-dialog", () => ({
  AddProcessDialog: () => <div data-testid="add-process-dialog" />,
}))

const dialogShow = vi.fn()
vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ show: dialogShow }),
}))

let paneState: any
vi.mock("../context/process-pane", () => ({
  useProcessPane: () => paneState,
}))

import { WorkspaceProcessesNavigator } from "./workspace-processes-navigator"

const config = (id: string, name: string): Process.ProcessConfig => ({
  id,
  name,
  command: "npm run dev",
  args: [],
  autoStart: false,
  restartPolicy: "never",
  maxRestarts: 3,
})

function makePane(overrides: Partial<any> = {}) {
  const managed = new Map<string, Process.ManagedProcess | undefined>()
  return {
    loaded: () => true,
    configs: () => [] as Process.ProcessConfig[],
    hasRunning: () => false,
    canMutate: () => true,
    processForConfig: (id: string) => managed.get(id),
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    startAll: vi.fn(),
    stopAll: vi.fn(),
    refresh: vi.fn(),
    __managed: managed,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  dialogShow.mockClear()
  document.body.innerHTML = ""
})

describe("WorkspaceProcessesNavigator", () => {
  test("renders a row per configured process", () => {
    paneState = makePane({ configs: () => [config("a", "Dev Server"), config("b", "Docs")] })
    const view = render(() => (
      <WorkspaceProcessesNavigator directory="/repo" onProcessSelect={() => {}} />
    ))
    expect(view.getByText("Dev Server")).toBeTruthy()
    expect(view.getByText("Docs")).toBeTruthy()
  })

  test("an idle process shows only Start", () => {
    paneState = makePane({ configs: () => [config("a", "Dev Server")] })
    const view = render(() => (
      <WorkspaceProcessesNavigator directory="/repo" onProcessSelect={() => {}} />
    ))
    expect(view.queryByLabelText("Start process")).toBeTruthy()
    expect(view.queryByLabelText("Stop process")).toBeNull()
    expect(view.queryByLabelText("Restart process")).toBeNull()
  })

  test("a running process shows Stop and Restart but not Start", () => {
    const pane = makePane({ configs: () => [config("a", "Dev Server")] })
    pane.__managed.set("a", { status: "running" } as Process.ManagedProcess)
    paneState = pane
    const view = render(() => (
      <WorkspaceProcessesNavigator directory="/repo" onProcessSelect={() => {}} />
    ))
    expect(view.queryByLabelText("Start process")).toBeNull()
    expect(view.queryByLabelText("Stop process")).toBeTruthy()
    expect(view.queryByLabelText("Restart process")).toBeTruthy()
  })

  test("a stopping process shows Stop but hides Start and Restart", () => {
    const pane = makePane({ configs: () => [config("a", "Dev Server")] })
    pane.__managed.set("a", { status: "stopping" } as Process.ManagedProcess)
    paneState = pane
    const view = render(() => (
      <WorkspaceProcessesNavigator directory="/repo" onProcessSelect={() => {}} />
    ))
    expect(view.queryByLabelText("Start process")).toBeNull()
    expect(view.queryByLabelText("Stop process")).toBeTruthy()
    expect(view.queryByLabelText("Restart process")).toBeNull()
  })

  test("clicking Stop invokes stop with the config id and stops row selection propagation", () => {
    const pane = makePane({ configs: () => [config("a", "Dev Server")] })
    pane.__managed.set("a", { status: "running" } as Process.ManagedProcess)
    const onProcessSelect = vi.fn()
    paneState = pane
    const view = render(() => (
      <WorkspaceProcessesNavigator directory="/repo" onProcessSelect={onProcessSelect} />
    ))
    fireEvent.click(view.getByLabelText("Stop process"))
    expect(pane.stop).toHaveBeenCalledWith("a")
    expect(onProcessSelect).not.toHaveBeenCalled()
  })

  test("read-only surface (canMutate=false) hides all per-row and Add controls", () => {
    paneState = makePane({
      configs: () => [config("a", "Dev Server")],
      canMutate: () => false,
    })
    const view = render(() => (
      <WorkspaceProcessesNavigator directory="/repo" onProcessSelect={() => {}} />
    ))
    expect(view.queryByLabelText("Start process")).toBeNull()
    expect(view.queryByLabelText("Add process")).toBeNull()
  })

  test("Add process opens the add-process dialog", () => {
    paneState = makePane({ configs: () => [config("a", "Dev Server")] })
    const view = render(() => (
      <WorkspaceProcessesNavigator directory="/repo" onProcessSelect={() => {}} />
    ))
    fireEvent.click(view.getByLabelText("Add process"))
    expect(dialogShow).toHaveBeenCalledTimes(1)
  })
})
