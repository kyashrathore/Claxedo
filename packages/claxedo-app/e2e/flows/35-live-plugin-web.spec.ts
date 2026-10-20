import path from "node:path"
import type { Page } from "@playwright/test"
import {
  appPluginDialog,
  appPluginRow,
  expect,
  installAndEnable,
  listLivePlugins,
  registerLivePlugin,
  sessionRoute,
  test,
  UI,
  writeFixturePlugin,
} from "../harness"

async function openFixture(url: string, app: Page) {
  await app.goto(`${url}/fixture`)
  return app.getByTitle("Fixture", { exact: true }).contentFrame()
}

async function accent(app: Page) {
  return app.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--fixture-accent").trim())
}

test.describe("installed from the registry", () => {
  test.use({ signedAppPluginRegistry: true })

  test("35 an app plugin installed for a signed account on the web: every primitive but panes and icon skins works from its sandboxed frame", async ({ signed, page: app }) => {
    const workspace = await signed.makeWorkspace("fixture", "Fixture project")
    await signed.appPluginRegistry?.publish(await writeFixturePlugin(path.join(signed.local.dataDir, "registry-plugins"), { label: "Fixture v1", routes: ["/api/claxedo/app-plugins"] }))
    await installAndEnable(signed, { id: "fixture", version: "0.1.0" })
    await signed.signIn(app, signed.owner)

    await app.goto(`${signed.url}/settings/app-plugins`)
    await expect(appPluginRow(app, "Fixture")).toContainText("From your organization")
    await expect(appPluginRow(app, "Fixture")).toContainText("On")

    const home = await openFixture(signed.url, app)
    await expect(home.getByRole("heading", { name: "Fixture v1" })).toBeVisible()
    await expect(home.getByText("Hello from the fixture on web")).toBeVisible()
    await expect(home.getByText("Projects: Fixture project")).toBeVisible()
    const results = home.getByRole("list", { name: "Fixture results" })

    await home.getByRole("button", { name: "Probe isolation" }).click()
    await expect(results).toContainText("storage blocked")
    await expect(results).toContainText("app document blocked")
    await home.getByRole("button", { name: "Fetch projects" }).click()
    await expect(results).toContainText("fetch 200")

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

    await app.goto(`${signed.url}/settings/appearance`)
    await app.getByRole("group", { name: "Theme" }).getByRole("button").click()
    await app.getByRole("option", { name: "Fixture theme", exact: true }).click()
    await expect(app.locator("html")).toHaveAttribute("data-theme", "fixture")
    await expect.poll(() => accent(app)).toBe("rgb(1, 2, 3)")

    await app.goto(`${signed.url}/settings/fixture%2Fprefs`)
    await expect(app.getByTitle("Fixture settings", { exact: true }).contentFrame().getByText("Fixture settings body")).toBeVisible()

    await app.goto(`${signed.url}${sessionRoute(workspace.id)}`)
    await app.getByRole("textbox", { name: UI.composer }).click()
    await app.keyboard.type("Look at @Fixture")
    await app.getByRole("option", { name: /Fixture note one/ }).click()
    await expect(app.getByRole("textbox", { name: UI.composer })).toContainText("fixture-note-one")
  })
})

test("35 an unsigned web app runs no app plugin, not even one its machine's registry serves", async ({ stack, app }) => {
  await stack.daemon.makeWorkspace("fixture", "Fixture project")
  expect(await registerLivePlugin(stack.url, await writeFixturePlugin(stack.dataDir, { label: "Fixture v1" }))).toMatchObject({ id: "fixture", status: "ready" })

  await app.goto(`${stack.url}/settings/app-plugins`)
  await expect(app.getByText("App plugins from the Marketplace need a signed-in account.", { exact: true })).toBeVisible()
  await expect(appPluginRow(app, "Tasks")).toContainText("Built in")
  await expect(appPluginDialog(app, "Turn on the app plugin Fixture?")).toHaveCount(0)
  await expect(appPluginRow(app, "Fixture")).toHaveCount(0)

  await app.goto(`${stack.url}/fixture`)
  await expect(app.getByTitle("Fixture", { exact: true })).toHaveCount(0)
  await app.goto(`${stack.url}/marketplace`)
  await expect(app.getByRole("region", { name: "App plugins" })).toHaveCount(0)
  expect((await listLivePlugins(stack.url)).plugins.map((row) => row.id)).toEqual(["fixture"])
})
