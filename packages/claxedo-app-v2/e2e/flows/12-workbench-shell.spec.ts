import type { Locator, Page } from "@playwright/test"
import { expect, SCRIPTED_ACP_HARNESS, test } from "../harness"

async function createProject(url: string, name: string, directory: string): Promise<void> {
  const response = await fetch(new URL("/api/claxedo/projects", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, source: { kind: "directory", directory } }),
  })
  expect(response.status).toBe(201)
}

function openPanes(app: Page): Locator {
  return app.getByRole("tablist", { name: "Open panes" })
}

function divider(app: Page): Locator {
  return app.getByRole("separator", { name: "Resize panes" })
}

async function dragTabToRightEdge(app: Page, title: string): Promise<void> {
  const tab = await openPanes(app).getByRole("tab", { name: title }).boundingBox()
  const center = await app.getByRole("main").boundingBox()
  if (!tab || !center) throw new Error("The tab or the workbench has no box")
  const start = { x: tab.x + tab.width / 2, y: tab.y + tab.height / 2 }
  await app.mouse.move(start.x, start.y)
  await app.mouse.down()
  await app.mouse.move(start.x + 12, start.y + 12, { steps: 4 })
  await app.mouse.move(center.x + center.width - 16, center.y + center.height / 2, { steps: 12 })
  await app.mouse.up()
}

async function openFromPalette(app: Page, command: string): Promise<void> {
  await app.keyboard.press("ControlOrMeta+Shift+KeyP")
  const palette = app.getByRole("dialog", { name: "Command palette" })
  await palette.getByRole("combobox", { name: "Command palette" }).fill(command)
  await palette.getByRole("option", { name: new RegExp(command) }).click()
}

test.skip(({ isMobile }) => isMobile, "flow 12 runs at desktop width; flow 33 covers the phone")

test("12 workbench and shell: tabs, split, drag, the palette, and settings in the one page tab", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("bench")
  await createProject(stack.url, "Bench", workspace.directory)
  const first = await api.createSession(workspace.directory, { title: "First", harness: SCRIPTED_ACP_HARNESS })
  const second = await api.createSession(workspace.directory, { title: "Second", harness: SCRIPTED_ACP_HARNESS })
  const titles = await Promise.all([first, second].map(async (session) => (await api.session(workspace.directory, session.id)).title))
  expect(titles).toEqual(["First", "Second"])

  await app.goto(`${stack.url}/w/${workspace.id}/s/${first.id}`)
  await expect(openPanes(app).getByRole("tab")).toHaveText(["First"])
  await app.goto(`${stack.url}/w/${workspace.id}/s/${second.id}`)
  await expect(openPanes(app).getByRole("tab")).toHaveText(titles)
  await expect(openPanes(app).getByRole("tab", { name: "Second" })).toHaveAttribute("aria-selected", "true")

  await app.keyboard.press("ControlOrMeta+Backslash")
  await expect(divider(app)).toBeVisible()
  await app.getByRole("button", { name: "Close pane" }).first().click()
  await expect(divider(app)).toHaveCount(0)
  await expect(openPanes(app).getByRole("tab")).toHaveText(titles)

  const hidden = (await openPanes(app).getByRole("tab", { selected: false }).innerText()).trim()
  await dragTabToRightEdge(app, hidden)
  await expect(divider(app)).toBeVisible()

  await openFromPalette(app, "Open settings")
  await expect(app).toHaveURL(/\/settings/)
  await expect(app.getByRole("tablist", { name: "Page" }).getByRole("tab")).toHaveText(["Settings"])
  await expect(openPanes(app)).toHaveCount(0)
  await expect(app.getByRole("navigation", { name: "Projects and sessions" }).getByRole("heading", { name: "Settings" })).toBeVisible()
  await expect(app.getByRole("region", { name: "Sessions" })).toHaveCount(0)
  await app.keyboard.press("ControlOrMeta+Backslash")
  await expect(divider(app)).toHaveCount(0)
  await expect(app.getByRole("button", { name: "Drag to move pane" })).toHaveCount(0)

  await app.getByRole("button", { name: "Close page" }).click()
  await expect(divider(app)).toBeVisible()
  await expect(openPanes(app).getByRole("tab")).toHaveText(titles)
  await expect(app.getByRole("region", { name: "Sessions" })).toBeVisible()

  await openPanes(app).getByRole("tab", { name: "First" }).focus()
  await app.keyboard.press("Delete")
  await expect(openPanes(app).getByRole("tab")).toHaveText(["Second"])
  await expect(divider(app)).toHaveCount(0)
  expect((await api.session(workspace.directory, first.id)).title).toBe("First")

  const sessions = app.getByRole("region", { name: "Sessions" })
  await sessions.getByRole("button", { name: "New session" }).click()
  await expect(openPanes(app).getByRole("tab")).toHaveText(["Second", "New session"])
  await expect(app.getByRole("region", { name: "New session" })).toBeVisible()
  await expect(sessions.getByRole("listitem")).toHaveCount(2)
  expect(await api.sessions(workspace.directory)).toHaveLength(2)
})
