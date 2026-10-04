import type { Page } from "@playwright/test"
import {
  APP_PLUGIN_WARNING,
  appPluginDialog,
  appPluginRow,
  approveAppPlugin,
  breakFixturePlugin,
  expect,
  fixtureFolder,
  listLivePlugins,
  pageTransport,
  registerLivePlugin,
  test,
  UI,
  writeFixturePlugin,
  writeLivePlugin,
  type Desktop,
} from "../harness"

async function startWithFixture(desktop: Desktop) {
  const workspace = await desktop.makeWorkspace("fixture", "Fixture project")
  const folder = await writeFixturePlugin(desktop.dataDir, { label: "Fixture v1" })
  const window = desktop.window
  expect(await registerLivePlugin(desktop.url, folder, pageTransport(window))).toMatchObject({ id: "fixture", status: "ready" })
  await window.reload()
  await approveAppPlugin(window, "Turn on the app plugin Fixture?", APP_PLUGIN_WARNING.desktop)
  return { workspace, folder, window }
}

async function openSettingsSection(window: Page, link: string) {
  await window.getByRole("button", { name: UI.signInAccount, exact: true }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("link", { name: link, exact: true }).click()
}

async function leaveSettings(window: Page) {
  await window.getByRole("link", { name: "Back" }).click()
}

async function runCommand(window: Page, title: string) {
  const palette = window.getByRole("dialog", { name: UI.palette })
  await expect(async () => {
    await window.keyboard.press("ControlOrMeta+Shift+KeyP")
    await expect(palette).toBeVisible({ timeout: 1000 })
  }).toPass()
  await palette.getByRole("textbox").fill(title)
  await expect(palette.getByText(title, { exact: true })).toBeVisible()
  await window.keyboard.press("Enter")
}

function fixtureHome(window: Page) {
  return window.getByRole("region", { name: "Fixture home" })
}

async function openFixture(window: Page) {
  await window.getByRole("button", { name: "Fixture", exact: true }).click()
  return fixtureHome(window)
}

test("34 a live plugin on the desktop: every primitive works in the app, panes and icon skins included", { tag: "@desktop" }, async ({ desktop }) => {
  const { workspace, window } = await startWithFixture(desktop)
  await openSettingsSection(window, "App plugins")
  await expect(appPluginRow(window, "Fixture")).toContainText("On")
  await leaveSettings(window)

  const home = await openFixture(window)
  await expect(home.getByRole("heading", { name: "Fixture v1" })).toBeVisible()
  await expect(home.getByText("Hello from the fixture on desktop")).toBeVisible()
  await expect(home.getByText("Projects: Fixture project")).toBeVisible()
  const results = home.getByRole("list", { name: "Fixture results" })
  await home.getByRole("button", { name: "Probe isolation" }).click()
  await expect(results).toContainText("storage readable")
  await home.getByRole("button", { name: "Fetch projects" }).click()
  await expect(results).toContainText("fetch 200")
  await home.getByRole("button", { name: "Create a document" }).click()
  await expect(results).toContainText("documents 1")

  await home.getByRole("button", { name: "Show a toast" }).click()
  await expect(window.getByText("Fixture toast")).toBeVisible()
  await home.getByRole("button", { name: "Ask to confirm" }).click()
  await appPluginDialog(window, "Fixture confirm?").getByRole("button", { name: "Yes, confirm" }).click()
  await expect(results).toContainText("confirmed true")

  await home.getByRole("button", { name: "Open the overlay" }).click()
  await expect(window.getByText("Fixture overlay", { exact: true })).toBeVisible()
  await window.getByRole("button", { name: "Close the fixture overlay" }).click()
  await expect(window.getByText("Fixture overlay", { exact: true })).toHaveCount(0)

  await runCommand(window, "Fixture: say hello")
  await expect(window.getByText("Fixture command ran")).toBeVisible()

  await openSettingsSection(window, "Appearance")
  await window.getByRole("group", { name: "Theme" }).getByRole("button").click()
  await window.getByRole("option", { name: "Fixture theme", exact: true }).click()
  await expect(window.locator("html")).toHaveAttribute("data-theme", "fixture")
  await expect
    .poll(() => window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--fixture-accent").trim()))
    .toBe("rgb(1, 2, 3)")
  await window.getByRole("link", { name: "Fixture settings", exact: true }).click()
  await expect(window.getByText("Fixture settings body")).toBeVisible()
  await leaveSettings(window)
  await expect(window.locator("[data-icon-skin]").first()).toBeVisible()
  await expect((await openFixture(window)).getByText("Host theme: fixture", { exact: true })).toBeVisible()

  await window.getByRole("button", { name: UI.newSession }).first().click()
  await window.getByRole("textbox", { name: UI.composer }).click()
  await window.keyboard.type("Look at @Fixture")
  await window.getByRole("option", { name: /Fixture note one/ }).click()
  await expect(window.getByRole("textbox", { name: UI.composer })).toContainText("fixture-note-one")
  await runCommand(window, "Fixture: open a pane")
  await expect(window.getByText("Fixture pane: Pane state")).toBeVisible()

  await (await openFixture(window)).getByRole("button", { name: "Start a session" }).click()
  await expect(window.getByText("Hello from the fixture").first()).toBeVisible()
  await expect.poll(async () => (await desktop.api.sessions(workspace.directory)).map((session) => session.title)).toContain("Fixture session")
})

test("34 a live plugin on the desktop swaps on save, keeps its last build on a broken save, asks again when its access changes, turns off and is removed", { tag: "@desktop" }, async ({ desktop }) => {
  const { folder, window } = await startWithFixture(desktop)
  const home = await openFixture(window)
  await expect(home.getByRole("heading", { name: "Fixture v1" })).toBeVisible()
  await writeLivePlugin(folder, fixtureFolder({ label: "Fixture v2" }))
  await expect(home.getByRole("heading", { name: "Fixture v2" })).toBeVisible()

  await breakFixturePlugin(folder)
  await openSettingsSection(window, "App plugins")
  const row = appPluginRow(window, "Fixture")
  await expect(row).toContainText("The newest build failed, so the previous one keeps running")
  await expect(row).toContainText("Code changed since you approved")
  await leaveSettings(window)
  await expect((await openFixture(window)).getByRole("heading", { name: "Fixture v2" })).toBeVisible()

  await writeLivePlugin(folder, fixtureFolder({ label: "Fixture v3", routes: ["/api/claxedo/projects", "/api/claxedo/tasks"] }))
  const access = appPluginDialog(window, "The app plugin Fixture asks for different access")
  await expect(access.getByRole("region", { name: "Now asks for" })).toContainText("Route /api/claxedo/tasks")
  await expect(window.getByRole("button", { name: "Fixture", exact: true })).toHaveCount(0)
  await access.getByRole("button", { name: "Turn on" }).click()
  await expect((await openFixture(window)).getByRole("heading", { name: "Fixture v3" })).toBeVisible()

  await openSettingsSection(window, "App plugins")
  await appPluginRow(window, "Fixture").getByRole("switch", { name: "Fixture on" }).dispatchEvent("click")
  await expect(appPluginRow(window, "Fixture")).toContainText("Off")
  await expect(window.getByRole("link", { name: "Fixture settings", exact: true })).toHaveCount(0)
  await appPluginRow(window, "Fixture").getByRole("button", { name: "Remove" }).click()
  await appPluginDialog(window, "Remove Fixture?").getByRole("button", { name: "Remove" }).click()
  await expect(appPluginRow(window, "Fixture")).toHaveCount(0)
  await expect(window.getByText("No app plugins yet.")).toBeVisible()
  expect((await listLivePlugins(desktop.url, pageTransport(window))).plugins).toEqual([])
})
