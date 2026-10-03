import type { Locator, Page, TestInfo } from "@playwright/test"
import { acpScriptToken, expect, SCRIPTED_ACP_HARNESS, UI, type ClaxedoApi, type Stack } from "./index"
import { sidebarFilter } from "./sidebar-filter"
import { readerPage, readerRow, settleReader } from "./session-reader"
import { sidebarSectionFilter } from "./activity-layout"

export function activityRow(app: Page, title: string): Locator {
  return app.getByTestId("activity-session-row").filter({ has: app.getByRole("button", { name: title, exact: true }) })
}

async function openActivity(stack: Stack, app: Page, phone: boolean): Promise<void> {
  await app.goto(`${stack.url}/`)
  if (phone) await app.getByRole("button", { name: UI.openRail }).tap()
  await sidebarFilter(app, "Activity", phone)
  await expect(app.getByRole("region", { name: "Activity", exact: true })).toBeVisible()
}

async function expectOrder(stack: Stack, app: Page): Promise<void> {
  await expect.poll(async () => {
    const page = await readerPage(stack, { settled: "active" })
    const shown = await app.getByTestId("activity-session-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-session-id")))
    return JSON.stringify(shown) === JSON.stringify(page.items.map((row) => row.sessionId))
  }).toBe(true)
}

async function rowContext(stack: Stack, app: Page, title: string): Promise<void> {
  const row = activityRow(app, title)
  const canonical = (await readerPage(stack)).items.find((item) => item.title === title)!
  await expect(row.getByText("Activity project", { exact: true })).toBeVisible()
  const titleBox = await row.getByText(title, { exact: true }).boundingBox()
  const projectBox = await row.getByText("Activity project", { exact: true }).boundingBox()
  expect(titleBox!.y).toBeLessThan(projectBox!.y)
  expect(canonical.workspaceId).toBeTruthy()
  expect(await row.innerText()).not.toContain("README.md")
}

export async function activitySidebar(stack: Stack, api: ClaxedoApi, app: Page, phone: boolean, info: TestInfo): Promise<void> {
  const workspace = await stack.daemon.makeWorkspace("activity", "Activity project")
  const first = await api.createSession(workspace.directory, { title: "Fresh result", harness: SCRIPTED_ACP_HARNESS })
  const working = await api.createSession(workspace.directory, { title: "Moving work", harness: SCRIPTED_ACP_HARNESS })
  await stack.acp.write("activity-result", { steps: [{ kind: "text", text: "Ready to settle" }] })
  await stack.acp.write("activity-work", { steps: [{ kind: "hold", name: "activity-work" }, { kind: "text", text: "Work complete" }] })
  await api.prompt(workspace.directory, first.id, `Finish ${acpScriptToken("activity-result")}`)
  await api.promptAsync(workspace.directory, working.id, `Work ${acpScriptToken("activity-work")}`)
  await openActivity(stack, app, phone)
  await expectOrder(stack, app)
  await sidebarSectionFilter(app, phone)
  await rowContext(stack, app, first.title)
  await expect(activityRow(app, working.title).getByRole("button", { name: `Settle ${working.title}` })).toBeDisabled()
  const activate = activityRow(app, working.title).getByRole("button", { name: working.title, exact: true })
  await activate.focus()
  await stack.acp.release("activity-work")
  await expect.poll(async () => (await readerRow(stack, working.id)).attention.working).toBe(false)
  await expect(activate).toBeFocused()
  await expectOrder(stack, app)
  const settle = activityRow(app, first.title).getByRole("button", { name: `Settle ${first.title}` })
  if (phone) await settle.tap()
  else { await activityRow(app, first.title).hover(); await settle.click() }
  await expect(activityRow(app, first.title)).toHaveCount(0)
  const settled = await readerRow(stack, first.id)
  expect(settled.reader?.settledThrough).toBe(settled.attention.activitySequence)
  expect((await api.session(workspace.directory, first.id)).time.archived).toBeUndefined()
  await expectOrder(stack, app)
  await app.reload()
  if (phone) await app.getByRole("button", { name: UI.openRail }).tap()
  await expect(app.getByTestId("activity-sidebar")).toBeVisible()
  await expect(activityRow(app, first.title)).toHaveCount(0)
  await info.attach(phone ? "flat-activity-phone" : "flat-activity-desktop", { body: await app.screenshot(), contentType: "image/png" })
}

export async function virtualActivitySidebar(stack: Stack, api: ClaxedoApi, app: Page, phone = false): Promise<void> {
  const workspace = await stack.daemon.makeWorkspace("activity-many", "Many project")
  const sessions = []
  for (let index = 0; index < 126; index += 1) sessions.push(await api.createSession(workspace.directory, { title: `Many ${index}`, harness: SCRIPTED_ACP_HARNESS }))
  const settled = sessions[125]
  await settleReader(stack, await readerRow(stack, settled.id))
  await openActivity(stack, app, phone)
  const region = app.getByRole("region", { name: "Activity", exact: true })
  const more = region.getByRole("button", { name: "Load more", exact: true })
  for (let page = 0; page < 4; page += 1) { await more.scrollIntoViewIfNeeded(); await more.click(); if (page < 3) await expect(more).toBeEnabled() }
  await expect(more).toHaveCount(0)
  const rows = app.getByTestId("activity-session-row")
  await expect.poll(() => rows.count()).toBeGreaterThan(0)
  expect(await rows.count()).toBeLessThan(40)
  await rows.first().getByRole("button").first().focus()
  await app.keyboard.press("End")
  await expect(activityRow(app, "Many 0").getByRole("button", { name: "Many 0", exact: true })).toBeFocused()
  await app.keyboard.press("Home")
  await expect(activityRow(app, "Many 124").getByRole("button", { name: "Many 124", exact: true })).toBeFocused()
  await expect(activityRow(app, settled.title)).toHaveCount(0)
  expect((await readerPage(stack, { settled: "active" })).totalKnown).toBe(125)
}
