import { createSignal, type JSX } from "solid-js"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createLayoutProjectsApi } from "@/app/providers/layout-projects"
import { PaneCtxProvider } from "../context/pane-ctx"
import type { PaneCtx } from "../workbench/workbench"
import { ProjectCreateCanvasProvider, WorkspaceUnavailableSurface } from "./workspace-unavailable-surface"

const layout = vi.hoisted(() => ({ projects: undefined as unknown }))

vi.mock("@/app/providers/layout", () => ({
  useLayout: () => layout,
}))

function projectsApi() {
  return createLayoutProjectsApi({
    list: () => [],
    server: { projects: {} as never },
    rootFor: (directory) => directory,
    validProjectRef: () => true,
    ensureDirectorySessionCache: () => {},
    sidebarProjects: () => [],
  })
}

function paneCtx(input: { visible: () => boolean; focused: () => boolean }): PaneCtx {
  return {
    paneId: "pane-1",
    isFocused: input.focused,
    isVisible: input.visible,
    element: () => undefined,
    onKeyDown: () => {},
    requestClose: () => {},
    requestFocus: () => {},
    presentation: () => "docked",
  }
}

function canvas() {
  return <div data-testid="create-canvas" />
}

function unavailable(): JSX.Element {
  return (
    <WorkspaceUnavailableSurface>
      <div data-testid="workspace-offline" />
    </WorkspaceUnavailableSurface>
  )
}

let projects: ReturnType<typeof projectsApi>

beforeEach(() => {
  projects = projectsApi()
  layout.projects = projects
  window.__claxedoMainContentReady = undefined
})

afterEach(cleanup)

describe("WorkspaceUnavailableSurface", () => {
  test("is settled content: mounting it releases the boot splash", () => {
    render(() => <ProjectCreateCanvasProvider value={canvas}>{unavailable()}</ProjectCreateCanvasProvider>)

    expect(screen.getByTestId("workspace-offline")).toBeTruthy()
    expect(window.__claxedoMainContentReady).toBe(true)
  })

  test("the focused pane answers New Project with the create canvas and keeps it once answered", () => {
    render(() => (
      <ProjectCreateCanvasProvider value={canvas}>
        <PaneCtxProvider ctx={paneCtx({ visible: () => true, focused: () => true })}>{unavailable()}</PaneCtxProvider>
      </ProjectCreateCanvasProvider>
    ))

    expect(projects.hasCreateSurface()).toBe(true)
    projects.requestCreate()

    expect(screen.getByTestId("create-canvas")).toBeTruthy()
    expect(screen.queryByTestId("workspace-offline")).toBeNull()
    projects.answerCreate()
    expect(projects.createPending()).toBe(false)
    expect(screen.getByTestId("create-canvas")).toBeTruthy()
  })

  test("a request raised before the pane proved unavailable is answered when it mounts", () => {
    projects.requestCreate()

    render(() => <ProjectCreateCanvasProvider value={canvas}>{unavailable()}</ProjectCreateCanvasProvider>)

    expect(screen.getByTestId("create-canvas")).toBeTruthy()
  })

  test.each([
    ["hidden", { visible: false, focused: true }],
    ["unfocused", { visible: true, focused: false }],
  ])("a %s pane neither registers nor answers until it is the focused one", (_label, state) => {
    const [visible, setVisible] = createSignal(state.visible)
    const [focused, setFocused] = createSignal(state.focused)
    render(() => (
      <ProjectCreateCanvasProvider value={canvas}>
        <PaneCtxProvider ctx={paneCtx({ visible, focused })}>{unavailable()}</PaneCtxProvider>
      </ProjectCreateCanvasProvider>
    ))

    expect(projects.hasCreateSurface()).toBe(false)
    projects.requestCreate()
    expect(screen.getByTestId("workspace-offline")).toBeTruthy()
    expect(screen.queryByTestId("create-canvas")).toBeNull()

    setVisible(true)
    setFocused(true)
    expect(projects.hasCreateSurface()).toBe(true)
    expect(screen.getByTestId("create-canvas")).toBeTruthy()
  })

  test("outside the workbench canvas there is no create canvas to offer, so it stays out of the registry", () => {
    render(() => unavailable())

    expect(projects.hasCreateSurface()).toBe(false)
    projects.requestCreate()
    expect(screen.getByTestId("workspace-offline")).toBeTruthy()
    expect(window.__claxedoMainContentReady).toBe(true)
  })

  test("unmounting releases its registration", () => {
    const [shown, setShown] = createSignal(true)
    render(() => (
      <ProjectCreateCanvasProvider value={canvas}>{shown() ? unavailable() : null}</ProjectCreateCanvasProvider>
    ))

    expect(projects.hasCreateSurface()).toBe(true)
    setShown(false)
    expect(projects.hasCreateSurface()).toBe(false)
  })
})
