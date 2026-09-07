import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { workspacePanelFullWidthCommand, workspacePanelVisibilityCommand } from "./commands"
import type { LayoutPreset } from "./config"
import { createShellLayoutState } from "./state"

describe("shell layout state", () => {
  test("initializes rail from migrated state and then owns toggles through LayoutConfig commands", () => {
    createRoot((dispose) => {
      const layout = createShellLayoutState({
        target: () => "web",
        preset: () => "claxedo.default",
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
        preset: () => "claxedo.default",
        initialRail: { collapsed: true, pinned: false, width: 260 },
        initialWorkspacePanel: { open: false },
      })

      layout.trackRailPosition(12, 12, () => ({ top: 0, right: 260, bottom: 600 }))
      expect(layout.config().regions.rail.size).toEqual({ unit: "px", value: 260 })

      layout.trackRailPosition(400, 12, () => ({ top: 0, right: 260, bottom: 600 }))
      expect(layout.config().regions.rail.size).toEqual({ unit: "px", value: 0 })
      dispose()
    })
  })

  // Measuring the rail box is a forced layout, and the caller hands it over as
  // a getter so only the branch that compares against it pays. A pointer move
  // over a pinned rail decides nothing, and the click Chromium delivers with a
  // mousemove lands inside the session activation's flush — where a forced
  // layout on a just-dirtied sidebar is the most expensive moment to take one.
  test("does not measure the rail box on pointer moves that cannot collapse it", () => {
    createRoot((dispose) => {
      const layout = createShellLayoutState({
        target: () => "web",
        preset: () => "claxedo.default",
        initialRail: { collapsed: false, pinned: true, width: 260 },
        initialWorkspacePanel: { open: false },
      })

      let measured = 0
      const railRect = () => {
        measured += 1
        return { top: 0, right: 260, bottom: 600 }
      }
      // Pinned: nothing a pointer move can do to it.
      layout.trackRailPosition(400, 400, railRect)
      expect(measured).toBe(0)
      dispose()
    })

    createRoot((dispose) => {
      const floating = createShellLayoutState({
        target: () => "web",
        preset: () => "claxedo.default",
        initialRail: { collapsed: true, pinned: false, width: 260 },
        initialWorkspacePanel: { open: false },
      })
      let measured = 0
      const railRect = () => {
        measured += 1
        return { top: 0, right: 260, bottom: 600 }
      }
      // Collapsed: the move is a hot-zone question, answered without the box.
      floating.trackRailPosition(400, 400, railRect)
      expect(measured).toBe(0)

      // Expanded and floating is the one case that has to compare.
      floating.peekRail(true)
      floating.trackRailPosition(400, 400, railRect)
      expect(measured).toBe(1)
      dispose()
    })
  })

  test("keeps workspace panel commands independent from rail commands", () => {
    createRoot((dispose) => {
      const layout = createShellLayoutState({
        target: () => "desktop",
        preset: () => "claxedo.default",
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
        preset: () => "claxedo.default",
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
        preset: () => "claxedo.default",
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

  test("switching the preset accessor re-derives the config and keeps the latched rail command", () => {
    createRoot((dispose) => {
      const [preset, setPreset] = createSignal<LayoutPreset>("claxedo.default")
      const layout = createShellLayoutState({
        target: () => "web",
        preset,
        initialRail: { collapsed: false, pinned: true, width: 260 },
        initialWorkspacePanel: { open: false, width: 520 },
        initialNavigator: { width: 300 },
      })

      layout.toggleRail()
      expect(layout.config().regions.navigator).toBeUndefined()
      expect(layout.config().regions.workspacePanel.size).toEqual({ unit: "px", value: 520 })

      setPreset("claxedo.navigator-sidebar")
      expect(layout.config().presetId).toBe("claxedo.navigator-sidebar")
      expect(layout.config().regions.navigator).toMatchObject({
        slot: "navigator",
        side: "left",
        size: { unit: "px", value: 300 },
        order: 1,
      })
      expect(layout.config().regions.workspacePanel.size).toEqual({ unit: "percent", value: 100 })
      expect(layout.config().regions.rail).toMatchObject({
        size: { unit: "px", value: 0 },
        docked: false,
      })

      setPreset("claxedo.default")
      expect(layout.config().regions.navigator).toBeUndefined()
      expect(layout.config().regions.rail.docked).toBe(false)
      dispose()
    })
  })

  test("resizes the navigator within its clamp and reports the committed width without a region", () => {
    createRoot((dispose) => {
      const [preset, setPreset] = createSignal<LayoutPreset>("claxedo.navigator-sidebar")
      const layout = createShellLayoutState({
        target: () => "web",
        preset,
        initialRail: { collapsed: false, pinned: true, width: 260 },
        initialWorkspacePanel: { open: false, width: 520 },
      })

      expect(layout.navigatorWidth()).toBe(320)
      expect(layout.committedNavigatorWidth()).toBe(320)

      layout.setNavigatorWidth(400)
      expect(layout.config().regions.navigator.size).toEqual({ unit: "px", value: 400 })
      expect(layout.navigatorWidth()).toBe(400)

      layout.setNavigatorWidth(100)
      expect(layout.config().regions.navigator).toMatchObject({
        size: { unit: "px", value: 260 },
        visible: true,
        docked: true,
      })
      expect(layout.committedNavigatorWidth()).toBe(260)

      layout.setNavigatorWidth(Number.NaN)
      expect(layout.navigatorWidth()).toBe(260)

      setPreset("claxedo.default")
      expect(layout.config().regions.navigator).toBeUndefined()
      expect(layout.navigatorWidth()).toBe(260)
      dispose()
    })
  })

  test("closing the panel clears the size slot so the next open is full under the sidebar preset", () => {
    createRoot((dispose) => {
      const layout = createShellLayoutState({
        target: () => "web",
        preset: () => "claxedo.navigator-sidebar",
        initialRail: { collapsed: false, pinned: true, width: 260 },
        initialWorkspacePanel: { open: false, width: 520 },
      })

      layout.setWorkspacePanelOpen(true)
      expect(layout.config().regions.workspacePanel).toMatchObject({
        visible: true,
        size: { unit: "percent", value: 100 },
      })

      layout.dispatch("workspacePanelSize", workspacePanelFullWidthCommand(layout.config(), layout.workspacePanelWidth()))
      expect(layout.config().regions.workspacePanel.size).toEqual({ unit: "px", value: 520 })
      expect(layout.workspacePanelWidth()).toBe(520)

      layout.dispatch("workspacePanelSize", undefined)
      layout.setWorkspacePanelOpen(false)
      expect(layout.config().regions.workspacePanel.visible).toBe(false)

      layout.setWorkspacePanelOpen(true)
      expect(layout.config().regions.workspacePanel).toMatchObject({
        visible: true,
        size: { unit: "percent", value: 100 },
      })
      dispose()
    })
  })
})
