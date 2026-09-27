import fs from "node:fs/promises"
import path from "node:path"
import type { Page } from "@playwright/test"
import { apiRequests, expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, UI, type HarnessFixtures } from "../harness"

test.skip(({ isMobile }) => isMobile, "flow 14 runs at desktop width")

function rootListingReads(app: Page) {
  const reads: string[] = []
  app.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname === "/api/wr/file" && url.searchParams.get("path") === "") reads.push(request.url())
  })
  return reads
}

async function openSession(input: Pick<HarnessFixtures, "stack" | "api" | "app">, name: string) {
  const { stack, api, app } = input
  const workspace = await stack.daemon.makeWorkspace(name)
  const session = await api.createSession(workspace.directory, { title: "Press", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
  const toggle = app.getByRole("button", { name: UI.openPanel })
  const box = await toggle.boundingBox()
  if (!box) throw new Error("the panel toggle has no box")
  const panel = app.getByRole("complementary", { name: "Workspace panel" })
  return {
    workspace,
    toggle,
    toggleCenter: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    panel,
    readme: panel.getByRole("treeitem", { name: /^README\.md/ }),
    settled: apiRequests(app, stack.url),
  }
}

test("14 pressing the panel toggle reads the files root listing before the release opens the panel, and the tree uses that read", async ({ stack, api, app }) => {
  const { toggleCenter, panel, readme, settled } = await openSession({ stack, api, app }, "press")
  const reads = rootListingReads(app)
  await app.mouse.move(toggleCenter.x, toggleCenter.y)
  await app.mouse.down()
  await expect.poll(() => reads.length, { message: "root listing reads while the button is held" }).toBe(1)
  await expect(panel).toHaveCount(0)
  await app.mouse.up()
  await expect(readme).toBeVisible()
  await settled()
  expect(reads, "root listing reads for one press and open").toHaveLength(1)
})

test("14 a press released off the panel toggle leaves the panel closed, and the next click opens it on the listing that press read", async ({ stack, api, app }) => {
  const { toggle, toggleCenter, panel, readme, settled } = await openSession({ stack, api, app }, "cancelled")
  const reads = rootListingReads(app)
  const composer = await app.getByRole("textbox", { name: UI.composer }).boundingBox()
  if (!composer) throw new Error("the composer has no box")
  await app.mouse.move(toggleCenter.x, toggleCenter.y)
  await app.mouse.down()
  await app.mouse.move(composer.x + composer.width / 2, composer.y + composer.height / 2, { steps: 4 })
  await app.mouse.up()
  await settled()
  await expect(panel).toHaveCount(0)
  expect(reads, "root listing reads for the cancelled press").toHaveLength(1)
  await toggle.click()
  await expect(readme).toBeVisible()
  await settled()
  expect(reads, "root listing reads after the click opens the panel").toHaveLength(1)
})

test("14 Enter on the focused panel toggle opens the panel and loads the files tree without a press", async ({ stack, api, app }) => {
  const { toggle, panel, readme, settled } = await openSession({ stack, api, app }, "keyboard")
  const reads = rootListingReads(app)
  await toggle.focus()
  await app.keyboard.press("Enter")
  await expect(panel).toBeVisible()
  await expect(readme).toBeVisible()
  await settled()
  expect(reads, "root listing reads for a keyboard open").toHaveLength(1)
})

test("14 pressing the panel toggle when the panel opens on Changes reads no files listing", async ({ stack, api, app }) => {
  const { workspace, toggle, panel, readme, settled } = await openSession({ stack, api, app }, "changes")
  await fs.writeFile(path.join(workspace.directory, "README.md"), "edited\n")
  await toggle.click()
  await expect(readme).toBeVisible()
  await panel.getByRole("button", { name: "Open Changes", exact: true }).click()
  await expect(panel.getByTestId("source-control-groups")).toBeVisible()
  await panel.getByRole("button", { name: "Close workspace panel", exact: true }).click()
  await expect(panel).toHaveCount(0)
  await app.reload()
  await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
  await settled()

  const reads = rootListingReads(app)
  const box = await toggle.boundingBox()
  if (!box) throw new Error("the panel toggle has no box")
  await app.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await app.mouse.down()
  await settled()
  expect(reads, "root listing reads while the button is held").toEqual([])
  await app.mouse.up()
  await expect(panel.getByTestId("source-control-groups")).toBeVisible()
  await expect(panel.getByTestId("workspace-files-navigator")).toHaveCount(0)
  await settled()
  expect(reads, "root listing reads for an open on Changes").toEqual([])
})
