import { fileURLToPath } from "node:url"
import type { Page } from "@playwright/test"
import { marketplacePanel } from "../harness/marketplace-panel"
import {
  acpScriptToken,
  expect,
  expectWithinBaseline,
  SCRIPTED_ACP_HARNESS,
  sessionRoute,
  test,
  type ClaxedoApi,
  type SessionRow,
  type Stack,
  type Workspace,
  UI,
} from "../harness"

const IMAGE = fileURLToPath(new URL("../../public/web-app-manifest-192x192.png", import.meta.url))

type Arranged = { readonly workspace: Workspace; readonly first: SessionRow; readonly second: SessionRow }

async function arrange(stack: Stack, api: ClaxedoApi): Promise<Arranged> {
  const workspace = await stack.daemon.makeWorkspace("phone", "Phone")
  await stack.acp.write("first", { steps: [{ kind: "text", text: "The first session's reply" }] })
  const first = await api.createSession(workspace.directory, { title: "First", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, first.id, `Open the first session. ${acpScriptToken("first")}`)
  const second = await api.createSession(workspace.directory, { title: "Second", harness: SCRIPTED_ACP_HARNESS })
  return { workspace, first, second }
}

async function expectNoHorizontalScroll(app: Page): Promise<void> {
  const overflow = await app.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

async function drawer(stack: Stack, api: ClaxedoApi, app: Page, arranged: Arranged): Promise<void> {
  await app.goto(`${stack.url}/`)
  const open = app.getByRole("button", { name: UI.openRail })
  await expect(open).toBeVisible()
  await expectNoHorizontalScroll(app)
  await open.tap()
  await expect(app.getByRole("button", { name: "Close navigation sidebar" })).toBeVisible()
  const nav = app.getByRole("navigation", { name: UI.rail })
  await nav.getByRole("button", { name: "First" }).tap()
  await expect(app).toHaveURL(new RegExp(`/s/${arranged.first.id}$`))
  await test.step("no session title bar (DECISIONS Owner, 17:15)", async () => {
    await expect(app.getByText("The first session's reply")).toBeVisible()
  })
  await expect(open).toBeVisible()
  await expectNoHorizontalScroll(app)
  await expectWithinBaseline(app, "session-page")
  await open.tap()
  await nav.getByRole("button", { name: "Second" }).tap()
  await expect(app).toHaveURL(new RegExp(`/s/${arranged.second.id}$`))
  expect((await api.session(arranged.workspace.directory, arranged.second.id)).title).toBe("Second")
}

async function panel(app: Page): Promise<void> {
  await app.getByRole("button", { name: UI.openPanel }).tap()
  const panel = app.getByRole("complementary", { name: "Workspace panel" })
  await expect(panel).toBeVisible()
  await expectNoHorizontalScroll(app)
  await panel.getByRole("button", { name: "Close workspace panel" }).tap()
  await expect(panel).toHaveCount(0)
}

test.skip(({ isMobile }) => !isMobile, "flow 33 runs in the phone project")

test("33 phone: Marketplace details use the full-width shared panel with touch close and no workspace controls", async ({
  stack,
  app,
}, testInfo) => {
  await marketplacePanel(stack, app, true, testInfo)
})

test("33 phone: the drawer, two sessions and the workspace panel, no horizontal scroll, an axe sweep", async ({ stack, api, app }) => {
  await drawer(stack, api, app, await arrange(stack, api))
  await panel(app)
})

test("33 phone: the drawer stays open on a session while another project gains sessions", async ({ stack, api, app }) => {
  const arranged = await arrange(stack, api)
  const other = await stack.daemon.makeWorkspace("elsewhere", "Elsewhere")
  await api.createSession(other.directory, { title: "Earlier", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}/`)
  const open = app.getByRole("button", { name: UI.openRail })
  await open.tap()
  const nav = app.getByRole("navigation", { name: UI.rail })
  await nav.getByRole("button", { name: "First" }).tap()
  await expect(app).toHaveURL(new RegExp(`/s/${arranged.first.id}$`))
  await open.tap()
  const close = app.getByRole("button", { name: "Close navigation sidebar" })
  await expect(close).toBeVisible()
  for (const title of ["Arrived 1", "Arrived 2"]) {
    await api.createSession(other.directory, { title, harness: SCRIPTED_ACP_HARNESS })
    await expect(nav.getByRole("button", { name: title })).toBeVisible()
  }
  await expect(close).toBeVisible()
  await expect(app).toHaveURL(new RegExp(`/s/${arranged.first.id}$`))
  expect((await api.sessions(other.directory)).map((session) => session.title)).toContain("Arrived 2")
})

test("33 phone: what a mouse reveals on hover shows on touch, and icon buttons keep a 44 px target", async ({ stack, api, app }) => {
  const pages = await stack.localPages({ "/preview.html": "<!doctype html><title>Preview</title><h1>Preview page</h1>" })
  const workspace = await stack.daemon.makeWorkspace("touch", "Touch")
  await stack.acp.write("link", { steps: [{ kind: "text", text: `Open the [preview page](${pages.url}/preview.html).` }] })
  const session = await api.createSession(workspace.directory, { title: "Touch", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, session.id, `Link the preview. ${acpScriptToken("link")}`)
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await expect(app.getByRole("link", { name: "preview page" })).toBeVisible()

  const panelButton = await app.getByRole("button", { name: UI.openPanel }).boundingBox()
  expect(panelButton?.width).toBeGreaterThanOrEqual(44)
  expect(panelButton?.height).toBeGreaterThanOrEqual(44)

  const chooser = app.waitForEvent("filechooser")
  await app.getByRole("button", { name: "Add", exact: true }).tap()
  await app.getByRole("menuitem", { name: /Images and files/ }).tap()
  await (await chooser).setFiles(IMAGE)
  await expect(app.getByRole("button", { name: "Remove attachment" })).toHaveCSS("opacity", "1")
  await expect(app.getByRole("button", { name: "Mark up image" })).toHaveCSS("opacity", "1")

  await app.getByRole("link", { name: "preview page" }).tap()
  const panel = app.getByRole("complementary", { name: "Workspace panel" })
  await expect(panel.getByRole("textbox", { name: "Enter URL or search" })).toHaveValue(`${pages.url}/preview.html`)
  await expect(panel.getByRole("button", { name: "Close review" })).toHaveCSS("opacity", "1")
  await panel.getByRole("button", { name: "Close workspace panel" }).tap()

  await app.setViewportSize({ width: 1024, height: 768 })
  await app.getByRole("button", { name: UI.hideSidebar }).tap()
  await expect(app.getByRole("button", { name: "Close Touch", exact: true })).toHaveCSS("opacity", "1")
  expect(pages.requested).toEqual(["/preview.html"])
})


test("33 phone: an invitation link uses the auth screen without horizontal scroll and has touch targets", async ({ stack, app }) => {
  await app.goto(`${stack.url}/invitations/phone-invitation`)
  await expect(app.getByRole("heading", { name: "Join your organization" })).toBeVisible()
  await expect(app.getByText("Use the email address that received this invitation.")).toBeVisible()
  await expectNoHorizontalScroll(app)
  const button = app.getByRole("button").first()
  await expect(button).toBeVisible()
  const target = await button.boundingBox()
  expect(target?.width).toBeGreaterThanOrEqual(44)
  expect(target?.height).toBeGreaterThanOrEqual(44)
})
