import fs from "node:fs/promises"
import path from "node:path"
import type { Locator } from "@playwright/test"
import { expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, UI } from "../harness"

test.skip(({ isMobile }) => isMobile, "flow 14 runs at desktop width")

async function span(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error("the control is not laid out")
  return { left: box.x, right: box.x + box.width }
}

for (const side of ["left", "right"] as const) {
  test(`14 with the files navigator on the ${side}, the Review row puts Files, Changes and the diff view above it and the scope above the diff, in Tab order`, async ({ stack, api, app }) => {
    await app.addInitScript((value) => localStorage.setItem("claxedo:appearance:fonts", JSON.stringify({ navigatorSide: value })), side)
    const workspace = await stack.daemon.makeWorkspace(`side-${side}`)
    await fs.appendFile(path.join(workspace.directory, "README.md"), "a changed line\n")
    const session = await api.createSession(workspace.directory, { title: "Side", harness: SCRIPTED_ACP_HARNESS })

    await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
    await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
    await app.getByRole("button", { name: UI.openPanel }).click()
    const panel = app.getByRole("complementary", { name: "Workspace panel" })
    await panel.getByRole("button", { name: "Review", exact: true }).click()
    await panel.getByRole("button", { name: "Open Changes", exact: true }).click()
    const column = app.getByTestId("workspace-navigator-overlay")
    await expect(column).toHaveAttribute("data-navigator-side", side)
    await expect(panel.getByTestId("source-control-groups")).toBeVisible()

    const header = app.getByTestId("workbench-l2-header")
    const scope = header.getByTestId("review-compare-trigger")
    const navigatorControls = [header.getByRole("button", { name: "Open Files" }), header.getByRole("button", { name: "Close Changes" })]
    const diffView = [header.getByRole("button", { name: "Expand all" }), header.getByRole("button", { name: "Split" })]
    const expected = side === "left" ? [...navigatorControls, ...diffView, scope] : [scope, ...diffView, ...navigatorControls]
    for (const control of expected) await expect(control).toBeVisible()

    const lefts = await Promise.all(expected.map(async (control) => (await span(control)).left))
    expect(lefts, "the row's controls from left to right").toEqual(lefts.toSorted((a, b) => a - b))
    const navigator = await span(column)
    for (const control of [...navigatorControls, ...diffView]) {
      const box = await span(control)
      expect(box.left >= navigator.left && box.right <= navigator.right, "a navigator control sits above the navigator").toBe(true)
    }
    const scopeBox = await span(scope)
    expect(side === "left" ? scopeBox.left >= navigator.right : scopeBox.right <= navigator.left, "the scope sits above the diff").toBe(true)

    await expected[0].focus()
    for (const control of expected.slice(1)) {
      await app.keyboard.press("Tab")
      await expect(control).toBeFocused()
    }
  })
}
