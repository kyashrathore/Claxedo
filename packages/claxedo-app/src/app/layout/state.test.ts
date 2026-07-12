import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { workspacePanelFullWidthCommand, workspacePanelVisibilityCommand } from "./commands"
import { createShellLayoutState } from "./state"

describe("shell layout state", () => {
  test("initializes rail from migrated state and then owns toggles through LayoutConfig commands", () => {
    createRoot((dispose) => {
      const layout = createShellLayoutState({
        target: () => "web",
        initialRail: { collapsed: true, pinned: false, width: 300 },
        initialWorkspacePanel: { open: false, width: 520 },
      })

      expect(layout.config().regions.rail).toMatchObject({
        size: { unit: "px", value: 0 },
        docked: false,
      })

      layout.toggleRail()
      expect(layout.config().regions.rail).toMatchObject({
        size: { unit: "px", value: 300 },
        docked: true,
      })

      layout.toggleRail()
      expect(layout.config().regions.rail).toMatchObject({
        size: { unit: "px", value: 0 },
        docked: false,
      })
      dispose()
    })
  })

  test("tracks floating rail peeks without writing legacy rail state", () => {
    createRoot((dispose) => {
      const layout = createShellLayoutState({
        target: () => "web",
        initialRail: { collapsed: true, pinned: false, width: 260 },
        initialWorkspacePanel: { open: false },
      })

      layout.trackRailPosition(12, 12, { top: 0, right: 260, bottom: 600 })
      expect(layout.config().regions.rail.size).toEqual({ unit: "px", value: 260 })

      layout.trackRailPosition(400, 12, { top: 0, right: 260, bottom: 600 })
      expect(layout.config().regions.rail.size).toEqual({ unit: "px", value: 0 })
      dispose()
    })
  })

  test("keeps workspace panel commands independent from rail commands", () => {
    createRoot((dispose) => {
      const layout = createShellLayoutState({
        target: () => "desktop",
        initialRail: { collapsed: false, pinned: true, width: 260 },
        initialWorkspacePanel: { open: false, width: 520 },
      })

      layout.dispatch("workspacePanelVisibility", workspacePanelVisibilityCommand(true))
      layout.dispatch("workspacePanelSize", workspacePanelFullWidthCommand(layout.config()))
      layout.toggleRail()

      expect(layout.config().regions.rail).toMatchObject({
        size: { unit: "px", value: 0 },
        docked: false,
      })
      expect(layout.config().regions.workspacePanel).toMatchObject({
        visible: true,
        size: { unit: "percent", value: 100 },
      })
      dispose()
    })
  })

  test("resizes the docked rail and snaps below the minimum to fully collapsed", () => {
    createRoot((dispose) => {
      const layout = createShellLayoutState({
        target: () => "desktop",
        initialRail: { collapsed: false, pinned: true, width: 260 },
        initialWorkspacePanel: { open: false, width: 520 },
      })

      layout.setRailWidth(360)
      expect(layout.config().regions.rail).toMatchObject({
        size: { unit: "px", value: 360 },
        docked: true,
      })
      expect(layout.committedRailWidth()).toBe(360)

      layout.setRailWidth(180)
      expect(layout.config().regions.rail).toMatchObject({
        size: { unit: "px", value: 0 },
        docked: false,
      })
      expect(layout.committedRailWidth()).toBe(360)

      layout.toggleRail()
      expect(layout.config().regions.rail).toMatchObject({
        size: { unit: "px", value: 360 },
        docked: true,
      })
      dispose()
    })
  })

  test("owns workspace panel committed visibility and measured width", () => {
    createRoot((dispose) => {
      const layout = createShellLayoutState({
        target: () => "web",
        initialRail: { collapsed: false, pinned: true, width: 260 },
        initialWorkspacePanel: { open: false, width: 520 },
      })

      layout.setWorkspacePanelOpen(true)
      layout.setWorkspacePanelWidth(640)

      expect(layout.config().regions.workspacePanel).toMatchObject({
        visible: true,
        size: { unit: "px", value: 640 },
      })
      expect(layout.workspacePanelWidth()).toBe(640)
      dispose()
    })
  })
})
