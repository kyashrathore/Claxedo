import AxeBuilder from "@axe-core/playwright"
import type { Page } from "@playwright/test"
import { expect, SCRIPTED_ACP_HARNESS, test } from "../harness"

async function createProject(url: string, name: string, directory: string): Promise<void> {
  const response = await fetch(new URL("/api/claxedo/projects", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, source: { kind: "directory", directory } }),
  })
  expect(response.status).toBe(201)
}

async function settled(app: Page): Promise<void> {
  await app.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.then(() => undefined, () => undefined)),
    ),
  )
}

async function sweep(app: Page, screen: string): Promise<void> {
  await settled(app)
  const results = await new AxeBuilder({ page: app }).analyze()
  const violations = results.violations.map((violation) => `${screen}: ${violation.id} ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`)
  expect(violations).toEqual([])
}

async function expectNoHorizontalScroll(app: Page): Promise<void> {
  const overflow = await app.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

test.skip(({ isMobile }) => !isMobile, "flow 33 runs in the phone project")

test("33 phone: the rail as home, the drawer, the pane switcher and the sheet, no horizontal scroll, an axe sweep", async ({ stack, api, app }) => {
  test.skip(stack.app === "v1", "the v1 path of this baseline flow is not written yet")
  const workspace = await stack.daemon.makeWorkspace("phone")
  await createProject(stack.url, "Phone", workspace.directory)
  const first = await api.createSession(workspace.directory, { title: "First", harness: SCRIPTED_ACP_HARNESS })
  const second = await api.createSession(workspace.directory, { title: "Second", harness: SCRIPTED_ACP_HARNESS })

  await app.goto(`${stack.url}/`)
  const home = app.getByRole("navigation", { name: "Projects and sessions" })
  await expect(home.getByRole("region", { name: "Sessions" }).getByRole("listitem")).toHaveCount(2)
  await expectNoHorizontalScroll(app)
  await sweep(app, "home")

  await home.getByRole("link", { name: /First$/ }).tap()
  await expect(app).toHaveURL(new RegExp(`/w/${workspace.id}/s/${first.id}$`))
  await expect(home).toHaveCount(0)
  await expect(app.getByRole("heading", { level: 1, name: "First" })).toBeVisible()
  await expectNoHorizontalScroll(app)
  await sweep(app, "session")

  await app.getByRole("button", { name: "Open menu" }).tap()
  const drawer = app.getByRole("dialog", { name: "Sidebar" })
  await expect(drawer.getByRole("navigation", { name: "Projects and sessions" })).toBeVisible()
  await sweep(app, "drawer")
  await drawer.getByRole("link", { name: /Second$/ }).tap()
  await expect(drawer).toHaveCount(0)
  await expect(app).toHaveURL(new RegExp(`/w/${workspace.id}/s/${second.id}$`))
  expect((await api.session(workspace.directory, second.id)).title).toBe("Second")

  await app.getByRole("button", { name: "Switch pane" }).tap()
  await expect(app.getByRole("menuitem")).toHaveCount(2)
  await app.keyboard.press("Escape")

  await app.getByRole("button", { name: "Toggle workspace panel" }).tap()
  const sheet = app.getByRole("dialog", { name: "Workspace panel" })
  await expect(sheet.getByRole("tab", { name: "Files" })).toBeVisible()
  await expectNoHorizontalScroll(app)
  await sweep(app, "sheet")
  await sheet.getByRole("button", { name: "Close" }).tap()
  await expect(sheet).toHaveCount(0)
})
