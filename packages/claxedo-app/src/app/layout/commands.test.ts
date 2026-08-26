import { describe, expect, test } from "bun:test"
import {
  applyLayoutCommand,
  railPeekCommand,
  railToggleCommand,
  workspacePanelFullWidthCommand,
  workspacePanelVisibilityCommand,
} from "./commands"
import { defaultLayoutConfig } from "./config"

describe("layout commands", () => {
  test("updates a region through a command", () => {
    const config = defaultLayoutConfig()

    expect(
      applyLayoutCommand(config, {
        type: "region.update",
        regionId: "workspacePanel",
        region: {
          visible: true,
          size: { unit: "px", value: 640 },
        },
      }).regions.workspacePanel,
    ).toMatchObject({
      visible: true,
      size: { unit: "px", value: 640 },
    })
  })

  test("ignores region update commands for missing regions", () => {
    const config = defaultLayoutConfig()

    expect(
      applyLayoutCommand(config, {
        type: "region.update",
        regionId: "missing",
        region: { visible: true },
      }),
    ).toBe(config)
  })

  test("replaces and resets config through commands", () => {
    const config = defaultLayoutConfig({ target: "web" })
    const desktop = defaultLayoutConfig({ target: "desktop" })

    expect(applyLayoutCommand(config, { type: "replace", config: desktop })).toBe(desktop)
    expect(applyLayoutCommand(desktop, { type: "reset", target: "web" })).toEqual(
      defaultLayoutConfig({ target: "web" }),
    )
  })

  test("toggles workspace panel full width through region size commands", () => {
    const config = defaultLayoutConfig()
    const fullWidth = applyLayoutCommand(config, workspacePanelFullWidthCommand(config))
    const restored = applyLayoutCommand(fullWidth, workspacePanelFullWidthCommand(fullWidth, 640))

    expect(fullWidth.regions.workspacePanel.size).toEqual({ unit: "percent", value: 100 })
    expect(restored.regions.workspacePanel.size).toEqual({ unit: "px", value: 640 })
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
