import type { Page } from "@playwright/test"
import {
  expect,
  expectNoAxeViolations,
  expectWithinV1Baseline,
  SCRIPTED_ACP_HARNESS,
  test,
  type ClaxedoApi,
  type SessionRow,
  type Stack,
  type Workspace,
} from "../harness"

type Arranged = { readonly workspace: Workspace; readonly first: SessionRow; readonly second: SessionRow }

async function arrange(stack: Stack, api: ClaxedoApi): Promise<Arranged> {
  const workspace = await stack.daemon.makeWorkspace("phone")
  await api.createProject("Phone", workspace.directory)
  const first = await api.createSession(workspace.directory, { title: "First", harness: SCRIPTED_ACP_HARNESS })
  const second = await api.createSession(workspace.directory, { title: "Second", harness: SCRIPTED_ACP_HARNESS })
  return { workspace, first, second }
}

async function expectNoHorizontalScroll(app: Page): Promise<void> {
  const overflow = await app.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

async function v2Drawer(stack: Stack, api: ClaxedoApi, app: Page, arranged: Arranged): Promise<void> {
  await app.goto(`${stack.url}/`)
  const home = app.getByRole("navigation", { name: "Projects and sessions" })
  await expect(home.getByRole("region", { name: "Sessions" }).getByRole("listitem")).toHaveCount(2)
  await expectNoHorizontalScroll(app)
  await expectNoAxeViolations(app, "home")
  await home.getByRole("link", { name: /First$/ }).tap()
  await expect(app).toHaveURL(new RegExp(`/w/${arranged.workspace.id}/s/${arranged.first.id}$`))
  await expect(home).toHaveCount(0)
  await expect(app.getByRole("heading", { level: 1, name: "First" })).toBeVisible()
  await expectNoHorizontalScroll(app)
  await expectNoAxeViolations(app, "session")
  await app.getByRole("button", { name: "Open menu" }).tap()
  const drawer = app.getByRole("dialog", { name: "Sidebar" })
  await expect(drawer.getByRole("navigation", { name: "Projects and sessions" })).toBeVisible()
  await expectNoAxeViolations(app, "drawer")
  await drawer.getByRole("link", { name: /Second$/ }).tap()
  await expect(drawer).toHaveCount(0)
  await expect(app).toHaveURL(new RegExp(`/w/${arranged.workspace.id}/s/${arranged.second.id}$`))
  expect((await api.session(arranged.workspace.directory, arranged.second.id)).title).toBe("Second")
}

async function v2Panes(app: Page): Promise<void> {
  await app.getByRole("button", { name: "Switch pane" }).tap()
  await expect(app.getByRole("menuitem")).toHaveCount(2)
  await app.keyboard.press("Escape")
  await app.getByRole("button", { name: "Toggle workspace panel" }).tap()
  const sheet = app.getByRole("dialog", { name: "Workspace panel" })
  await expect(sheet.getByRole("tab", { name: "Files" })).toBeVisible()
  await expectNoHorizontalScroll(app)
  await expectNoAxeViolations(app, "sheet")
  await sheet.getByRole("button", { name: "Close" }).tap()
  await expect(sheet).toHaveCount(0)
}

async function v1Drawer(stack: Stack, api: ClaxedoApi, app: Page, arranged: Arranged): Promise<void> {
  await app.goto(`${stack.url}/`)
  const open = app.getByRole("button", { name: "Open navigation sidebar" })
  await expect(open).toBeVisible()
  await expectNoHorizontalScroll(app)
  await open.tap()
  await expect(app.getByRole("button", { name: "Close navigation sidebar" })).toBeVisible()
  const nav = app.getByRole("navigation", { name: "Projects and sessions" })
  await nav.getByRole("button", { name: "First" }).tap()
  await expect(app).toHaveURL(new RegExp(`/s/${arranged.first.id}$`))
  await expect(app.getByRole("heading", { level: 1, name: "First" })).toBeVisible()
  await expect(open).toBeVisible()
  await expectNoHorizontalScroll(app)
  await expectWithinV1Baseline(app, "session-page")
  await open.tap()
  await nav.getByRole("button", { name: "Second" }).tap()
  await expect(app).toHaveURL(new RegExp(`/s/${arranged.second.id}$`))
  expect((await api.session(arranged.workspace.directory, arranged.second.id)).title).toBe("Second")
}

async function v1Panel(app: Page): Promise<void> {
  await app.getByRole("button", { name: "Open workspace panel" }).tap()
  const panel = app.getByRole("complementary", { name: "Workspace panel" })
  await expect(panel).toBeVisible()
  await expectNoHorizontalScroll(app)
  await panel.getByRole("button", { name: "Close workspace panel" }).tap()
  await expect(panel).toHaveCount(0)
}

test.skip(({ isMobile }) => !isMobile, "flow 33 runs in the phone project")

test("33 phone: the rail, the drawer, the panes and the panel, no horizontal scroll, an axe sweep", async ({ stack, api, app }) => {
  const arranged = await arrange(stack, api)
  if (stack.app === "v1") {
    await v1Drawer(stack, api, app, arranged)
    await v1Panel(app)
    return
  }
  await v2Drawer(stack, api, app, arranged)
  await v2Panes(app)
})
