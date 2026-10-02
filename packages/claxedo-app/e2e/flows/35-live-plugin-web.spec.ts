import fs from "node:fs/promises"
import path from "node:path"
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
  registerLivePlugin,
  sessionRoute,
  test,
  UI,
  writeFixturePlugin,
  writeLivePlugin,
  type Stack,
} from "../harness"

async function openFixture(stack: Stack, app: Page) {
  await app.goto(`${stack.url}/fixture`)
  return app.getByTitle("Fixture", { exact: true }).contentFrame()
}

async function documentsOf(stack: Stack, projectId: string): Promise<readonly { display_name: string }[]> {
  const response = await fetch(`${stack.url}/documents?project_id=${encodeURIComponent(projectId)}`)
  expect(response.status).toBe(200)
  return (await response.json()) as { display_name: string }[]
}

async function accent(app: Page) {
  return app.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--fixture-accent").trim())
}

test("35 a live plugin on the web: every primitive but panes and icon skins works from its sandboxed frame", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("fixture", "Fixture project")
  expect(await registerLivePlugin(stack.url, await writeFixturePlugin(stack.dataDir, { label: "Fixture v1" }))).toMatchObject({ id: "fixture", status: "ready" })

  await app.goto(`${stack.url}/settings/app-plugins`)
  await approveAppPlugin(app, "Turn on the app plugin Fixture?", APP_PLUGIN_WARNING.web)
  await expect(appPluginRow(app, "Fixture")).toContainText("On")

  const home = await openFixture(stack, app)
  await expect(home.getByRole("heading", { name: "Fixture v1" })).toBeVisible()
  await expect(home.getByText("Hello from the fixture on web")).toBeVisible()
  await expect(home.getByText("Projects: Fixture project")).toBeVisible()
  const results = home.getByRole("list", { name: "Fixture results" })

  await home.getByRole("button", { name: "Probe isolation" }).click()
  await expect(results).toContainText("storage blocked")
  await expect(results).toContainText("app document blocked")
  await home.getByRole("button", { name: "Fetch projects" }).click()
  await expect(results).toContainText("fetch 200")
  await home.getByRole("button", { name: "Create a document" }).click()
  await expect(results).toContainText("documents 1")
  expect((await documentsOf(stack, workspace.projectId)).map((document) => document.display_name)).toEqual(["Fixture page"])

  await home.getByRole("button", { name: "Show a toast" }).click()
  await expect(app.getByText("Fixture toast")).toBeVisible()
  await home.getByRole("button", { name: "Ask to confirm" }).click()
  await appPluginDialog(app, "Fixture confirm?").getByRole("button", { name: "Yes, confirm" }).click()
  await expect(results).toContainText("confirmed true")

  await home.getByRole("button", { name: "Open the overlay" }).click()
  const overlay = app.getByTitle("finder", { exact: true }).contentFrame()
  await expect(overlay.getByText("Fixture overlay", { exact: true })).toBeVisible()
  await overlay.getByRole("button", { name: "Close the fixture overlay" }).click()
  await expect(app.getByTitle("finder", { exact: true })).toHaveCount(0)

  await app.keyboard.press("ControlOrMeta+Shift+KeyP")
  const palette = app.getByRole("dialog", { name: UI.palette })
  await palette.getByRole("textbox").fill("Fixture: say hello")
  await expect(palette.getByText("Fixture: say hello", { exact: true })).toBeVisible()
  await app.keyboard.press("Enter")
  await expect(app.getByText("Fixture command ran")).toBeVisible()

  await app.goto(`${stack.url}/settings/appearance`)
  await app.getByRole("group", { name: "Theme" }).getByRole("button").click()
  await app.getByRole("option", { name: "Fixture theme", exact: true }).click()
  await expect(app.locator("html")).toHaveAttribute("data-theme", "fixture")
  await expect.poll(() => accent(app)).toBe("rgb(1, 2, 3)")

  await app.goto(`${stack.url}/settings/fixture%2Fprefs`)
  await expect(app.getByTitle("Fixture settings", { exact: true }).contentFrame().getByText("Fixture settings body")).toBeVisible()

  await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
  await app.getByRole("textbox", { name: UI.composer }).click()
  await app.keyboard.type("Look at @Fixture")
  await app.getByRole("option", { name: /Fixture note one/ }).click()
  await expect(app.getByRole("textbox", { name: UI.composer })).toContainText("fixture-note-one")

  const started = await openFixture(stack, app)
  await started.getByRole("button", { name: "Start a session" }).click()
  await expect(app.getByText("Hello from the fixture").first()).toBeVisible()
  await expect.poll(async () => (await api.sessions(workspace.directory)).map((session) => session.title)).toContain("Fixture session")
})

test("35 a live plugin on the web swaps on save, keeps its last build on a broken save, asks again when its access changes, and is removed", async ({ stack, app }) => {
  await stack.daemon.makeWorkspace("fixture", "Fixture project")
  const folder = await writeFixturePlugin(stack.dataDir, { label: "Fixture v1" })
  await registerLivePlugin(stack.url, folder)
  await app.goto(`${stack.url}/settings/app-plugins`)
  await approveAppPlugin(app, "Turn on the app plugin Fixture?", APP_PLUGIN_WARNING.web)

  const home = await openFixture(stack, app)
  await expect(home.getByRole("heading", { name: "Fixture v1" })).toBeVisible()
  await writeLivePlugin(folder, fixtureFolder({ label: "Fixture v2" }))
  await expect(home.getByRole("heading", { name: "Fixture v2" })).toBeVisible()

  await breakFixturePlugin(folder)
  await app.goto(`${stack.url}/settings/app-plugins`)
  const row = appPluginRow(app, "Fixture")
  await expect(row).toContainText("The newest build failed, so the previous one keeps running")
  await expect(row).toContainText("Code changed since you approved")
  await expect((await openFixture(stack, app)).getByRole("heading", { name: "Fixture v2" })).toBeVisible()

  await writeLivePlugin(folder, fixtureFolder({ label: "Fixture v3", routes: ["/api/claxedo/projects", "/api/claxedo/tasks"] }))
  const access = appPluginDialog(app, "The app plugin Fixture asks for different access")
  await expect(access.getByRole("region", { name: "Now asks for" })).toContainText("Route /api/claxedo/tasks")
  await expect(app.getByTitle("Fixture", { exact: true })).toHaveCount(0)
  await access.getByRole("button", { name: "Turn on" }).click()
  await expect((await openFixture(stack, app)).getByRole("heading", { name: "Fixture v3" })).toBeVisible()

  await app.goto(`${stack.url}/settings/app-plugins?safe-mode`)
  await expect(app.getByRole("status").filter({ hasText: "Safe mode" })).toBeVisible()
  await expect(appPluginRow(app, "Fixture")).toContainText("Off")
  await app.getByRole("button", { name: "Leave safe mode" }).click()
  await expect(appPluginRow(app, "Fixture")).toContainText("On")

  await appPluginRow(app, "Fixture").getByRole("switch", { name: "Fixture on" }).click({ force: true })
  await expect(appPluginRow(app, "Fixture")).toContainText("Off")
  await appPluginRow(app, "Fixture").getByRole("switch", { name: "Fixture on" }).click({ force: true })
  await expect(appPluginRow(app, "Fixture")).toContainText("On")

  await appPluginRow(app, "Fixture").getByRole("button", { name: "Remove" }).click()
  await appPluginDialog(app, "Remove Fixture?").getByRole("button", { name: "Remove" }).click()
  await expect(appPluginRow(app, "Fixture")).toHaveCount(0)
  await expect(app.getByText("No app plugins yet.")).toBeVisible()
  expect((await listLivePlugins(stack.url)).plugins).toEqual([])
  await expect(fs.access(path.join(folder, "package.json"))).resolves.toBeUndefined()
})
