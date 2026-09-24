import type { Page } from "@playwright/test"
import { expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, UI } from "../harness"

function panes(app: Page) {
  return app.getByRole("navigation", { name: "Workbench panes" })
}

function divider(app: Page) {
  return app.getByRole("separator", { name: "Resize panes" })
}

async function dragRowToRightEdge(app: Page, title: string) {
  const row = await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: title, exact: true }).boundingBox()
  const bench = await app.getByRole("main").boundingBox()
  if (!row || !bench) throw new Error("The rail row or the workbench has no box")
  await app.mouse.move(row.x + row.width / 2, row.y + row.height / 2)
  await app.mouse.down()
  await app.mouse.move(row.x + row.width / 2 + 30, row.y + row.height / 2 + 20, { steps: 4 })
  await app.mouse.move(bench.x + bench.width - 12, bench.y + bench.height / 2, { steps: 12 })
  await app.mouse.up()
}

test.skip(({ isMobile }) => isMobile, "flow 12 runs at desktop width; flow 33 covers the phone")

test("12 workbench and shell: a rail row dragged to the edge splits, compact tabs, close a pane and a tab, the palette", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("bench", "Bench")
  const first = await api.createSession(workspace.directory, { title: "First", harness: SCRIPTED_ACP_HARNESS })
  await api.createSession(workspace.directory, { title: "Second", harness: SCRIPTED_ACP_HARNESS })

  await app.goto(`${stack.url}${sessionRoute(workspace.id, first.id)}`)
  await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: "Second", exact: true }).click()
  await expect(divider(app)).toHaveCount(0)
  await dragRowToRightEdge(app, "First")
  await expect(divider(app)).toBeVisible()
  await expect(app.getByRole("button", { name: "Close Pane" })).toHaveCount(2)

  await app.getByRole("button", { name: UI.hideSidebar }).click()
  await expect(panes(app).getByRole("button", { name: "First", exact: true })).toBeVisible()
  await expect(panes(app).getByRole("button", { name: "Second", exact: true })).toBeVisible()

  await app.getByRole("button", { name: "Close Pane" }).first().click()
  await expect(divider(app)).toHaveCount(0)

  await panes(app).getByRole("button", { name: "Close First" }).click()
  await expect(panes(app).getByRole("button", { name: "First", exact: true })).toHaveCount(0)
  await expect(panes(app).getByRole("button", { name: "Second", exact: true })).toBeVisible()
  expect((await api.session(workspace.directory, first.id)).title).toBe("First")

  await app.keyboard.press("ControlOrMeta+Shift+KeyP")
  await expect(app.getByRole("dialog", { name: UI.palette })).toBeVisible()
  await app.keyboard.press("Escape")
  await expect(app.getByRole("dialog", { name: UI.palette })).toHaveCount(0)
})
