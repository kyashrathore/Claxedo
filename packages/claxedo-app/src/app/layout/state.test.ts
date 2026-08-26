import { describe, expect, test } from "bun:test"
import { workspacePanelFullWidthCommand, workspacePanelVisibilityCommand } from "./commands"
import { createShellLayoutState } from "./state"
import { mountReactive } from "@/lib/test-support/reactive-root"

// The shell calls these setters from pointer and keyboard handlers, with no
// owner current; `mountReactive` gives the test the same shape.
const mountLayout = (input: Parameters<typeof createShellLayoutState>[0]) =>
  mountReactive(() => createShellLayoutState(input))

describe("shell layout state", () => {
  test("initializes rail from migrated state and then owns toggles through LayoutConfig commands", () => {
    const [layout, dispose] = mountLayout({
      target: () => "web",
      initialRail: { collapsed: true, pinned: false, width: 300 },
      initialWorkspacePanel: { open: false, width: 520 },
    })

    try {
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
    } finally {
      dispose()
    }
  })

  test("tracks floating rail peeks without writing legacy rail state", () => {
    const [layout, dispose] = mountLayout({
      target: () => "web",
      initialRail: { collapsed: true, pinned: false, width: 260 },
      initialWorkspacePanel: { open: false },
    })

    try {
      layout.trackRailPosition(12, 12, () => ({ top: 0, right: 260, bottom: 600 }))
      expect(layout.config().regions.rail.size).toEqual({ unit: "px", value: 260 })

      layout.trackRailPosition(400, 12, () => ({ top: 0, right: 260, bottom: 600 }))
      expect(layout.config().regions.rail.size).toEqual({ unit: "px", value: 0 })
    } finally {
      dispose()
    }
  })

  // Measuring the rail box is a forced layout, and the caller hands it over as
  // a getter so only the branch that compares against it pays. A pointer move
  // over a pinned rail decides nothing, and the click Chromium delivers with a
  // mousemove lands inside the session activation's flush — where a forced
  // layout on a just-dirtied sidebar is the most expensive moment to take one.
  test("does not measure the rail box on pointer moves that cannot collapse it", () => {
    const [pinned, disposePinned] = mountLayout({
      target: () => "web",
      initialRail: { collapsed: false, pinned: true, width: 260 },
      initialWorkspacePanel: { open: false },
    })

    try {
      let measured = 0
      const railRect = () => {
        measured += 1
        return { top: 0, right: 260, bottom: 600 }
      }
      // Pinned: nothing a pointer move can do to it.
      pinned.trackRailPosition(400, 400, railRect)
      expect(measured).toBe(0)
    } finally {
      disposePinned()
    }

    const [floating, disposeFloating] = mountLayout({
      target: () => "web",
      initialRail: { collapsed: true, pinned: false, width: 260 },
      initialWorkspacePanel: { open: false },
    })

    try {
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
    } finally {
      disposeFloating()
    }
  })

  test("keeps workspace panel commands independent from rail commands", () => {
    const [layout, dispose] = mountLayout({
      target: () => "desktop",
      initialRail: { collapsed: false, pinned: true, width: 260 },
      initialWorkspacePanel: { open: false, width: 520 },
    })

    try {
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
    } finally {
      dispose()
    }
  })

  test("resizes the docked rail and snaps below the minimum to fully collapsed", () => {
    const [layout, dispose] = mountLayout({
      target: () => "desktop",
      initialRail: { collapsed: false, pinned: true, width: 260 },
      initialWorkspacePanel: { open: false, width: 520 },
    })

    try {
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
    } finally {
      dispose()
    }
  })

  test("owns workspace panel committed visibility and measured width", () => {
    const [layout, dispose] = mountLayout({
      target: () => "web",
      initialRail: { collapsed: false, pinned: true, width: 260 },
      initialWorkspacePanel: { open: false, width: 520 },
    })

    try {
      layout.setWorkspacePanelOpen(true)
      layout.setWorkspacePanelWidth(640)

      expect(layout.config().regions.workspacePanel).toMatchObject({
        visible: true,
        size: { unit: "px", value: 640 },
      })
      expect(layout.workspacePanelWidth()).toBe(640)
    } finally {
      dispose()
    }
  })
})
