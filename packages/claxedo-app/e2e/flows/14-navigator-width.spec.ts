import fs from "node:fs/promises"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, git, SCRIPTED_ACP_HARNESS, sessionRoute, test, UI } from "../harness"

test.skip(({ isMobile }) => isMobile, "flow 14 runs at desktop width")

function navigatorFit(app: Page) {
  return app.getByTestId("workspace-navigator-overlay").evaluate((column) => {
    const content = column.firstElementChild as HTMLElement
    const box = column.getBoundingClientRect()
    const rows = [...column.querySelectorAll<HTMLElement>('[role="treeitem"], input, button')].filter((row) => row.getBoundingClientRect().width > 0)
    return {
      row: column.parentElement?.clientWidth ?? 0,
      column: column.clientWidth,
      content: content.getBoundingClientRect().width,
      scrollLeft: column.scrollLeft,
      clippedLeft: rows.filter((row) => row.getBoundingClientRect().left < box.left - 0.5).length,
    }
  })
}

async function expectWhole(app: Page, step: string) {
  await expect
    .poll(() => navigatorFit(app), { message: `the navigator column after ${step}` })
    .toMatchObject({ scrollLeft: 0, clippedLeft: 0 })
  const fit = await navigatorFit(app)
  expect(fit.content, `the navigator content width after ${step}`).toBeLessThanOrEqual(fit.column)
  expect(Math.abs(fit.column - Math.min(280, fit.row * 0.45)), `the navigator column against 45 % of the panel row after ${step}`).toBeLessThanOrEqual(1)
}

for (const side of ["left", "right"] as const) {
  test(`14 a ${side} files navigator in a panel narrower than 622 px shows its rows whole after a reveal, arrow focus and search`, async ({ stack, api, app }) => {
    await app.setViewportSize({ width: 1100, height: 760 })
    if (side === "right") await app.addInitScript(() => localStorage.setItem("claxedo:appearance:fonts", JSON.stringify({ navigatorSide: "right" })))
    const workspace = await stack.daemon.makeWorkspace(`width-${side}`)
    await fs.mkdir(path.join(workspace.directory, "source"))
    for (const name of ["alpha.ts", "beta.ts", "gamma.ts"]) await fs.writeFile(path.join(workspace.directory, "source", name), "export const value = 0\n")
    await git(workspace.directory, "add", "-A")
    await git(workspace.directory, "commit", "-qm", "source")
    await fs.writeFile(path.join(workspace.directory, "source/beta.ts"), "export const value = 1\n")
    const session = await api.createSession(workspace.directory, { title: "Width", harness: SCRIPTED_ACP_HARNESS })

    await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
    await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
    await app.getByRole("button", { name: UI.openPanel }).click()
    const panel = app.getByRole("complementary", { name: "Workspace panel" })
    await expect(app.getByTestId("workspace-navigator-overlay")).toHaveAttribute("data-navigator-side", side)
    expect((await navigatorFit(app)).row, "the panel row is narrower than 622 px").toBeLessThan(622)

    await panel.getByRole("treeitem", { name: "source", exact: true }).click()
    await panel.getByRole("treeitem", { name: /^beta\.ts/ }).click()
    await expectWhole(app, "revealing a file")
    await panel.getByRole("treeitem", { name: "source", exact: true }).focus()
    await app.keyboard.press("ArrowDown")
    await app.keyboard.press("ArrowDown")
    await expect(panel.getByRole("treeitem", { name: /^beta\.ts/ })).toBeFocused()
    await expectWhole(app, "arrow-key focus")
    await panel.getByPlaceholder("Search files...").focus()
    await expectWhole(app, "focusing the search")

    await panel.getByRole("button", { name: "Open Changes", exact: true }).click()
    await expect(panel.getByTestId("source-control-groups")).toBeVisible()
    await expectWhole(app, "opening Changes")
  })
}

for (const side of ["left", "right"] as const) {
  test(`14 a ${side} navigator's edge drags and steps by arrow keys within its limits, and the width survives a reload`, async ({ stack, api, app }) => {
    await app.setViewportSize({ width: 1400, height: 800 })
    if (side === "right") await app.addInitScript(() => localStorage.setItem("claxedo:appearance:fonts", JSON.stringify({ navigatorSide: "right" })))
    const workspace = await stack.daemon.makeWorkspace(`resize-${side}`)
    await fs.appendFile(path.join(workspace.directory, "README.md"), "a changed line\n")
    const session = await api.createSession(workspace.directory, { title: "Resize", harness: SCRIPTED_ACP_HARNESS })

    await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
    await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
    await app.getByRole("button", { name: UI.openPanel }).click()
    const panel = app.getByRole("complementary", { name: "Workspace panel" })
    await panel.getByRole("button", { name: "Open Changes", exact: true }).click()
    await expect(panel.getByTestId("source-control-groups")).toBeVisible()
    const column = app.getByTestId("workspace-navigator-overlay")
    const handle = panel.getByRole("separator", { name: "Resize navigator" })
    const width = () => column.evaluate((element) => element.clientWidth)
    const outward = side === "left" ? 1 : -1
    const before = await width()

    const box = await handle.boundingBox()
    if (!box) throw new Error("the navigator's edge is not laid out")
    await app.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await app.mouse.down()
    await app.mouse.move(box.x + box.width / 2 + outward * 90, box.y + box.height / 2, { steps: 6 })
    await app.mouse.up()
    await expect.poll(width, { message: "the width after a drag" }).toBe(before + 90)
    await expect(handle).toHaveAttribute("aria-valuenow", String(before + 90))

    await handle.focus()
    await app.keyboard.press(side === "left" ? "ArrowRight" : "ArrowLeft")
    await expect.poll(width, { message: "the width after an arrow key" }).toBe(before + 114)
    await app.keyboard.press("End")
    const row = await column.evaluate((element) => element.parentElement?.clientWidth ?? 0)
    await expect.poll(width, { message: "the widest navigator leaves the diff 40 % of the row" }).toBe(Math.floor(row * 0.6))
    await app.keyboard.press("Home")
    await expect.poll(width, { message: "the narrowest navigator" }).toBe(220)
    await app.keyboard.press(side === "left" ? "ArrowRight" : "ArrowLeft")
    await expect.poll(width).toBe(244)

    await app.reload()
    await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
    if (await app.getByRole("button", { name: UI.openPanel }).isVisible()) await app.getByRole("button", { name: UI.openPanel }).click()
    await expect(column).toHaveAttribute("data-open", "true")
    await expect.poll(width, { message: "the width after a reload" }).toBe(244)
  })
}
