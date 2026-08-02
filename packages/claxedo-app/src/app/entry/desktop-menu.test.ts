import { describe, expect, test } from "bun:test"

import { DESKTOP_MENU, desktopMenuItemLabel, type DesktopMenuItem } from "./desktop-menu"

const appMenu = () => DESKTOP_MENU.find((menu) => menu.id === "app")
const restartItem = () =>
  appMenu()?.items?.find((entry) => entry.type === "item" && entry.action === "app.relaunch") as
    | DesktopMenuItem
    | undefined

describe("desktopMenuItemLabel", () => {
  test("packaged shows the item's own label", () => {
    const item: DesktopMenuItem = { type: "item", label: "Restart", unpackagedLabel: "Reload Window" }
    expect(desktopMenuItemLabel(item, true)).toBe("Restart")
  })

  test("unpackaged shows the dev label when the item has one", () => {
    const item: DesktopMenuItem = { type: "item", label: "Restart", unpackagedLabel: "Reload Window" }
    expect(desktopMenuItemLabel(item, false)).toBe("Reload Window")
  })

  test("items without a dev label read the same either way", () => {
    const item: DesktopMenuItem = { type: "item", label: "Export Logs..." }
    expect(desktopMenuItemLabel(item, false)).toBe("Export Logs...")
    expect(desktopMenuItemLabel(item, true)).toBe("Export Logs...")
  })
})

describe("the Restart menu entry", () => {
  // Unpackaged, the app runs as a child of `electron-vite dev`; relaunching
  // quits that parent pipeline and takes the renderer's dev server with it. The
  // action falls back to a window reload there, so the label must not keep
  // promising a restart.
  test("names a reload in development and a restart when packaged", () => {
    const item = restartItem()
    expect(item).toBeDefined()
    expect(desktopMenuItemLabel(item!, true)).toBe("Restart")
    expect(desktopMenuItemLabel(item!, false)).toBe("Reload Window")
  })

  test("stays a single item rather than being removed in development", () => {
    // The owner allowed removing the button, but a working reload beats a gap.
    const items = appMenu()?.items ?? []
    const restarts = items.filter((entry) => entry.type === "item" && entry.action === "app.relaunch")
    expect(restarts).toHaveLength(1)
  })
})
