import type { Page } from "@playwright/test"
import { expect, git, installedCli, SCRIPTED_ACP_HARNESS, sendPrompt, sessionRoute, test, UI, type HarnessFixtures } from "../harness"

function details(app: Page) {
  const shell = app.getByTestId("workspace-panel-shell")
  const cards = app.locator('[data-component="session-details"]')
  return {
    shell,
    cards,
    where: cards.locator('[data-slot="details-environment"] [data-slot="details-where"]'),
    folder: cards.locator('[data-slot="details-folder"]'),
    branch: cards.locator('[data-slot="details-branch"]'),
    summary: cards.locator('[data-slot="details-background"] [data-slot="details-background-summary"]'),
    expand: cards.locator('[data-slot="details-background-toggle"]'),
    list: cards.locator('[data-slot="details-background-list"]'),
  }
}

async function openSession(input: Pick<HarnessFixtures, "stack" | "api" | "app">, name: string, titles: readonly string[]) {
  const { stack, api, app } = input
  const workspace = await stack.daemon.makeWorkspace(name, "Shop")
  await git(workspace.directory, "checkout", "-q", "-b", "cards-branch")
  const sessions = []
  for (const title of titles) sessions.push(await api.createSession(workspace.directory, { title, harness: SCRIPTED_ACP_HARNESS }))
  const first = sessions[0]
  if (!first) throw new Error("no session to open")
  await app.goto(`${stack.url}${sessionRoute(workspace.id, first.id)}`)
  await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
  return { workspace, sessions }
}

const railSession = (app: Page, title: string) => app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: title, exact: true })

const contextTab = (app: Page) => details(app).shell.locator('[data-slot="workspace-tab"][data-workspace-tab-kind="context"]')
const reviewTab = (app: Page) => details(app).shell.locator('[data-slot="workspace-tab"][data-workspace-tab-kind="review"]')

test("14 Session details opens the workspace panel on its Context tab, which drops the left border and the second header row, and says where the session runs", async ({ stack, api, app, isMobile }) => {
  test.skip(isMobile, "the phone case is its own test")
  const { sessions } = await openSession({ stack, api, app }, "details", ["Cards"])
  const view = details(app)
  await app.getByRole("button", { name: UI.showDetails }).click()

  await expect(view.shell).toHaveAttribute("data-state-open", "true")
  await expect(contextTab(app)).toHaveAttribute("data-selected", "true")
  await expect(view.cards).toHaveAttribute("data-session-id", sessions[0]?.id ?? "")
  await expect(view.where).toHaveText("This computer")
  await expect(view.folder).toHaveText("Shop")
  await expect(view.branch).toHaveText("cards-branch")
  await expect(view.summary).toHaveText("None")
  await expect(view.expand).toBeDisabled()
  await expect(view.shell).toHaveCSS("border-left-style", "none")
  await expect(app.getByTestId("workbench-l2-header")).toHaveCount(0)
  await expect(view.shell.getByRole("button", { name: "Maximize workspace panel" })).toBeVisible()

  await reviewTab(app).click()
  await expect(app.getByTestId("workbench-l2-header")).toBeVisible()
  await expect(view.shell).toHaveCSS("border-left-style", "solid")
  await contextTab(app).click()
  await expect(app.getByTestId("workbench-l2-header")).toHaveCount(0)

  await view.shell.getByRole("button", { name: "Close workspace panel", exact: true }).click()
  await expect(view.shell).toHaveAttribute("data-state-open", "false")
  await expect(app.getByTestId("workspace-panel-floating-chrome").getByRole("button", { name: UI.showDetails })).toBeVisible()
})

test("14 the Context tab shows the session the panel follows, and a session's open Context tab comes back on return", async ({ stack, api, app, isMobile }) => {
  test.skip(isMobile, "the phone case is its own test")
  const { sessions } = await openSession({ stack, api, app }, "follow", ["First", "Second"])
  const [first, second] = sessions
  if (!first || !second) throw new Error("two sessions expected")
  const view = details(app)
  await app.getByRole("button", { name: UI.showDetails }).click()
  await expect(view.cards).toHaveAttribute("data-session-id", first.id)

  await railSession(app, "Second").click()
  await expect(view.shell).toHaveAttribute("data-state-open", "false")
  await app.getByRole("button", { name: UI.showDetails }).click()
  await expect(view.cards).toHaveAttribute("data-session-id", second.id)

  await railSession(app, "First").click()
  await expect(contextTab(app)).toHaveAttribute("data-selected", "true")
  await expect(view.cards).toHaveAttribute("data-session-id", first.id)
})

test("14 on a phone Session details fills the screen with the cards and closes from the panel's own button", async ({ stack, api, app, isMobile }) => {
  test.skip(!isMobile, "the desktop cases are their own tests")
  const { sessions } = await openSession({ stack, api, app }, "phone", ["Pocket"])
  const view = details(app)
  await app.getByRole("button", { name: UI.showDetails }).click()
  await expect(view.cards).toHaveAttribute("data-session-id", sessions[0]?.id ?? "")
  const area = await view.shell.evaluate((element) => element.parentElement?.clientWidth)
  expect((await view.shell.boundingBox())?.width, "the panel's width on a phone").toBe(area)
  await expect(view.where).toHaveText("This computer")
  await view.shell.getByRole("button", { name: "Close workspace panel", exact: true }).click()
  await expect(view.shell).toHaveAttribute("data-state-open", "false")
})

test("14 a background agent is counted in the cards, listed when they unfold, and stops from its row there", async ({ stack, api, app, isMobile }) => {
  test.skip(isMobile, "the phone case is its own test")
  const availability = await installedCli("claude")
  test.skip(!availability.available, availability.available ? "" : availability.reason)
  const workspace = await stack.daemon.makeWorkspace("details-background", "Background")
  const model = await api.defaultModel(workspace.directory, "claude")
  const session = await api.createSession(workspace.directory, { title: "Survey", harness: { id: "claude", access: "native" }, model, permissionMode: "bypassPermissions" })
  stack.scripted.scriptTool({
    name: "Agent",
    whenPromptIncludes: "START_BACKGROUND",
    input: { description: "Background survey", prompt: "Survey the workspace slowly", subagent_type: "general-purpose", run_in_background: true },
  })
  stack.scripted.scriptTool({ name: "Bash", input: { command: "sleep 120", description: "Wait a while" } })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await sendPrompt(app, "START_BACKGROUND run a survey in the background")
  await expect(app.locator('[data-slot="session-background-work"]')).toHaveText("1 background agent running", { timeout: 60_000 })

  const view = details(app)
  await app.getByRole("button", { name: UI.showDetails }).click()
  await expect(view.summary).toHaveText("1 running")
  await expect(view.list).toHaveCount(0)
  await view.expand.click()
  await expect(view.list.locator('[data-action="subagent-stop"]')).toHaveCount(1)
  await view.list.locator('[data-action="subagent-stop"]').click()
  await expect(view.summary).toHaveText("None", { timeout: 60_000 })
  await expect(view.list).toHaveCount(0)
  await expect(app.locator('[data-slot="session-background-work"]')).toHaveCount(0)
})
