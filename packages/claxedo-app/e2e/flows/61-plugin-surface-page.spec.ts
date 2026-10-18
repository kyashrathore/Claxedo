import type { Page } from "@playwright/test"
import {
  APP_PLUGIN_WARNING,
  approveAppPlugin,
  appPluginRow,
  expect,
  listLivePlugins,
  registerLivePlugin,
  SURFACE_FIXTURE_NAME,
  SURFACE_FIXTURE_NO_PROJECT,
  SURFACE_FIXTURE_PATH,
  test,
  UI,
  writeSurfaceFixturePlugin,
} from "../harness"

type FixtureStack = { readonly url: string; readonly dataDir: string }

async function openSurfaceFixture(stack: FixtureStack, app: Page, isMobile: boolean) {
  expect(await registerLivePlugin(stack.url, await writeSurfaceFixturePlugin(stack.dataDir))).toMatchObject({ id: "surface-fixture", status: "ready" })
  await app.goto(`${stack.url}/settings/app-plugins`)
  await approveAppPlugin(app, `Turn on the app plugin ${SURFACE_FIXTURE_NAME}?`, APP_PLUGIN_WARNING.web)
  await expect(appPluginRow(app, SURFACE_FIXTURE_NAME)).toContainText("On")
  await app.goto(stack.url)
  if (isMobile) {
    await app.getByRole("button", { name: UI.openRail }).tap()
    await expect(app.getByRole("button", { name: "Close navigation sidebar" })).toBeVisible()
  }
  await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: SURFACE_FIXTURE_NAME, exact: true }).click()
  await expect(app).toHaveURL(new RegExp(`${SURFACE_FIXTURE_PATH}$`))
  const surface = app.locator('[data-component="surface"][data-source="plugin"]')
  await expect(surface).toBeVisible()
  return surface
}

test("61 an app plugin's surface page opens from the sidebar, draws natively in the app's document, and answers its button with a new item", async ({ stack, app, isMobile }) => {
  await stack.daemon.makeWorkspace("surface-page", "Surface project")
  const surface = await openSurfaceFixture(stack, app, isMobile)
  await expect(surface.locator('[data-slot="surface-source"]')).toHaveText(`${SURFACE_FIXTURE_NAME} · app plugin`)
  await expect(surface.getByRole("heading", { name: SURFACE_FIXTURE_NAME })).toBeVisible()
  await expect(surface.getByText("First item", { exact: true })).toBeVisible()
  await expect(surface.locator("iframe")).toHaveCount(0)
  await expect(app.getByTitle(SURFACE_FIXTURE_NAME, { exact: true })).toHaveCount(0)

  await surface.getByRole("textbox", { name: "Search items" }).fill("Typed by the reader")
  await surface.getByRole("button", { name: "Add item" }).click()
  await expect(surface.getByText("Typed by the reader", { exact: true })).toBeVisible()
  await expect(surface.getByText("First item", { exact: true })).toBeVisible()
  expect((await listLivePlugins(stack.url)).plugins).toEqual([expect.objectContaining({ id: "surface-fixture", status: "ready" })])
})

test("61 a surface page opened for another project reads that project when it opens", async ({ stack, app, isMobile }) => {
  await stack.daemon.makeWorkspace("surface-page", "Surface project")
  const second = await stack.daemon.makeWorkspace("surface-second", "Second project")
  const surface = await openSurfaceFixture(stack, app, isMobile)
  await surface.getByRole("button", { name: "Open Second project" }).click()
  await expect(app).toHaveURL(new RegExp(`${SURFACE_FIXTURE_PATH}/projects/${second.projectId}$`))
  await expect(surface.getByRole("heading", { name: "Fixture project" })).toBeVisible()
  await expect(surface.getByText("Second project", { exact: true })).toBeVisible()
  await expect(surface.getByText(SURFACE_FIXTURE_NO_PROJECT, { exact: true })).toHaveCount(0)
  const projects = (await (await fetch(new URL("/api/claxedo/projects", stack.url))).json()) as { projects: { id: string; name: string }[] }
  expect(projects.projects).toContainEqual(expect.objectContaining({ id: second.projectId, name: "Second project" }))
})
