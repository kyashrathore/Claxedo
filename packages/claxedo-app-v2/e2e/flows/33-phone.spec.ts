import type { Page } from "@playwright/test"
import {
  acpScriptToken,
  expect,
  expectWithinBaseline,
  SCRIPTED_ACP_HARNESS,
  test,
  type ClaxedoApi,
  type SessionRow,
  type Stack,
  type Workspace,
  UI,
} from "../harness"

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
