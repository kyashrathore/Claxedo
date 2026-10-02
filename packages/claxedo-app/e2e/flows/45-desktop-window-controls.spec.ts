import type { Locator } from "@playwright/test"
import { expect, test, UI } from "../harness"

const MAC_WINDOW_CONTROLS_INSET = 78

async function leftEdge(control: Locator): Promise<number> {
  const box = await control.boundingBox()
  if (!box) throw new Error("the control has no box")
  return box.x
}

test("45 desktop window controls: the sidebar toggles sit clear of the macOS window buttons", { tag: "@desktop" }, async ({ desktop }) => {
  test.skip(process.platform !== "darwin", "only macOS draws the window buttons over the page")
  await desktop.makeWorkspace("desktop-window-controls", "Window controls")
  const window = desktop.window
  await window.reload()
  const buttons = await desktop.electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.isVisible())?.getWindowButtonPosition() ?? null)
  expect(buttons).toEqual({ x: 12, y: 12 })

  const hide = window.getByRole("button", { name: UI.hideSidebar, exact: true })
  await expect(hide).toBeVisible()
  expect(await leftEdge(hide)).toBeGreaterThanOrEqual(MAC_WINDOW_CONTROLS_INSET)
  await window.screenshot({ path: test.info().outputPath("pinned.png"), clip: { x: 0, y: 0, width: 400, height: 80 } })

  await hide.click()
  const show = window.getByRole("button", { name: "Show Sidebar", exact: true })
  await expect(show).toBeVisible()
  expect(await leftEdge(show)).toBeGreaterThanOrEqual(MAC_WINDOW_CONTROLS_INSET)
  await window.screenshot({ path: test.info().outputPath("unpinned.png"), clip: { x: 0, y: 0, width: 400, height: 80 } })
})
