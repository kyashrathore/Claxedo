import { describe, expect, test } from "bun:test"
import {
  applyLayoutCommand,
  navigatorResizeCommand,
  railPeekCommand,
  railToggleCommand,
  workspacePanelFullWidthCommand,
  workspacePanelVisibilityCommand,
} from "./commands"
import { defaultLayoutConfig } from "./config"

describe("layout commands", () => {
  test("updates a region through a command", () => {
    const config = defaultLayoutConfig()

    expect(applyLayoutCommand(config, {
      type: "region.update",
      regionId: "workspacePanel",
      region: {
        visible: true,
        size: { unit: "px", value: 640 },
      },
    }).regions.workspacePanel).toMatchObject({
      visible: true,
      size: { unit: "px", value: 640 },
    })
  })

  test("ignores region update commands for missing regions", () => {
    const config = defaultLayoutConfig()

    expect(applyLayoutCommand(config, {
      type: "region.update",
      regionId: "missing",
      region: { visible: true },
    })).toBe(config)
  })

  test("replaces and resets config through commands", () => {
    const config = defaultLayoutConfig({ target: "web" })
    const desktop = defaultLayoutConfig({ target: "desktop" })

    expect(applyLayoutCommand(config, { type: "replace", config: desktop })).toBe(desktop)
    expect(applyLayoutCommand(desktop, { type: "reset", target: "web" })).toEqual(defaultLayoutConfig({ target: "web" }))
  })

  test("reset keeps the current preset", () => {
    const sidebar = defaultLayoutConfig({ preset: "claxedo.navigator-sidebar" })
    const resized = applyLayoutCommand(sidebar, navigatorResizeCommand(400))

    expect(applyLayoutCommand(resized, { type: "reset" })).toEqual(sidebar)
  })

  test("toggles workspace panel full width through region size commands", () => {
    const config = defaultLayoutConfig()
    const fullWidth = applyLayoutCommand(config, workspacePanelFullWidthCommand(config))
    const restored = applyLayoutCommand(fullWidth, workspacePanelFullWidthCommand(fullWidth, 640))

    expect(fullWidth.regions.workspacePanel.size).toEqual({ unit: "percent", value: 100 })
    expect(restored.regions.workspacePanel.size).toEqual({ unit: "px", value: 640 })
  })

  test("full-width command inverts under the navigator-sidebar preset: percent 100 → px restore width → percent 100", () => {
    const config = defaultLayoutConfig({ preset: "claxedo.navigator-sidebar" })
    expect(config.regions.workspacePanel.size).toEqual({ unit: "percent", value: 100 })

    const restored = applyLayoutCommand(config, workspacePanelFullWidthCommand(config, 520))
    expect(restored.regions.workspacePanel.size).toEqual({ unit: "px", value: 520 })

    const full = applyLayoutCommand(restored, workspacePanelFullWidthCommand(restored, 520))
    expect(full.regions.workspacePanel.size).toEqual({ unit: "percent", value: 100 })
    expect(full.regions.navigator).toEqual(config.regions.navigator)
  })

  test("clamps navigator resizes between 260 and 520 without ever collapsing", () => {
    const config = defaultLayoutConfig({ preset: "claxedo.navigator-sidebar" })

    expect(navigatorResizeCommand(400)).toEqual({
      type: "region.update",
      regionId: "navigator",
      region: { size: { unit: "px", value: 400 } },
    })
    expect(applyLayoutCommand(config, navigatorResizeCommand(0)).regions.navigator).toMatchObject({
      size: { unit: "px", value: 260 },
      visible: true,
      docked: true,
    })
    expect(applyLayoutCommand(config, navigatorResizeCommand(900)).regions.navigator.size).toEqual({ unit: "px", value: 520 })
    expect(applyLayoutCommand(config, navigatorResizeCommand(200, { minWidth: 100, maxWidth: 300 })).regions.navigator.size)
      .toEqual({ unit: "px", value: 200 })
    expect(applyLayoutCommand(config, navigatorResizeCommand(400)).regions.rail).toEqual(config.regions.rail)
  })

  test("navigator resize is a no-op under the default preset, which has no navigator region", () => {
    const config = defaultLayoutConfig()

    expect(applyLayoutCommand(config, navigatorResizeCommand(400))).toBe(config)
  })

  test("updates workspace panel visibility without clobbering size commands", () => {
    const config = defaultLayoutConfig()
    const open = applyLayoutCommand(config, workspacePanelVisibilityCommand(true))
    const fullWidthOpen = applyLayoutCommand(open, workspacePanelFullWidthCommand(open))
    const closed = applyLayoutCommand(fullWidthOpen, workspacePanelVisibilityCommand(false))

    expect(open.regions.workspacePanel.visible).toBe(true)
    expect(fullWidthOpen.regions.workspacePanel).toMatchObject({
      visible: true,
      size: { unit: "percent", value: 100 },
    })
    expect(closed.regions.workspacePanel).toMatchObject({
      visible: false,
      size: { unit: "percent", value: 100 },
    })
  })

  test("toggles rail width through a command without touching workspace panel regions", () => {
    const config = defaultLayoutConfig()
    const collapsed = applyLayoutCommand(config, railToggleCommand(config))
    const reopened = applyLayoutCommand(collapsed, railToggleCommand(collapsed, 300))

    expect(collapsed.regions.rail).toMatchObject({
      visible: true,
      size: { unit: "px", value: 0 },
      docked: false,
    })
    expect(collapsed.regions.workspacePanel).toEqual(config.regions.workspacePanel)
    expect(reopened.regions.rail).toMatchObject({
      size: { unit: "px", value: 300 },
      docked: true,
    })
  })

  test("opens and closes the floating rail through peek commands", () => {
    const config = applyLayoutCommand(defaultLayoutConfig(), railToggleCommand(defaultLayoutConfig()))
    const peeked = applyLayoutCommand(config, railPeekCommand(true, 280))
    const closed = applyLayoutCommand(peeked, railPeekCommand(false, 280))

    expect(config.regions.rail).toMatchObject({
      size: { unit: "px", value: 0 },
      docked: false,
    })
    expect(peeked.regions.rail).toMatchObject({
      visible: true,
      size: { unit: "px", value: 280 },
      docked: false,
    })
    expect(closed.regions.rail).toMatchObject({
      visible: true,
      size: { unit: "px", value: 0 },
      docked: false,
    })
  })
})
