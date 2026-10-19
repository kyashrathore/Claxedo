import type { Locator, Page } from "@playwright/test"
import {
  APP_PLUGIN_WARNING,
  approveAppPlugin,
  appPluginRow,
  expect,
  expectNothingAnimating,
  listLivePlugins,
  registerLivePlugin,
  SURFACE_FIXTURE_NAME,
  SURFACE_FIXTURE_PATH,
  SURFACE_FIXTURE_REMOTE_PICTURE,
  test,
  UI,
  writeSurfaceFixturePlugin,
} from "../harness"

async function openFixtureFromRail(app: Page, isMobile: boolean) {
  const row = app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: SURFACE_FIXTURE_NAME, exact: true })
  if (isMobile) {
    await expect(async () => {
      await expectNothingAnimating(app)
      const open = app.getByRole("button", { name: UI.openRail })
      if (await open.isVisible()) await open.tap()
      await expect(row).toBeInViewport({ ratio: 1, timeout: 1000 })
    }).toPass()
  }
  await row.click()
}

async function moveCardsOnTheBoard(surface: Locator, isMobile: boolean) {
  const todo = surface.getByRole("region", { name: "To do" })
  const done = surface.getByRole("region", { name: "Done" })
  const board = surface.locator('[data-slot="surface-board"]')
  await expect(surface.getByText("No card moved yet", { exact: true })).toBeVisible()
  if (isMobile) expect(await board.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
  else {
    const target = done.locator('[data-slot="surface-board-items"]')
    const box = await target.boundingBox()
    await todo.getByText("First card", { exact: true }).dragTo(target, { targetPosition: { x: 24, y: (box?.height ?? 40) - 4 } })
    await expect(surface.getByText("First card is in done at 2", { exact: true })).toBeVisible()
    await expect(done.getByText("First card", { exact: true })).toBeVisible()
    await expect(todo.getByText("First card", { exact: true })).toHaveCount(0)
  }
  const second = todo.locator('[data-slot="surface-board-item"]').filter({ hasText: "Second card" })
  await expect(second).toHaveAttribute("aria-roledescription", "movable item")
  await second.focus()
  await second.press(" ")
  await second.press("ArrowRight")
  const moved = done.locator('[data-slot="surface-board-item"]').filter({ hasText: "Second card" })
  await expect(moved).toBeFocused()
  await moved.press(" ")
  await expect(board.locator('[data-slot="surface-board-status"]')).toHaveText(/^Dropped in Done, position \d$/)
  await expect(surface.getByText(/^Second card is in done at \d$/)).toBeVisible()
  await expect(done.getByText("Second card", { exact: true })).toBeVisible()
  await expect(todo.getByText("Second card", { exact: true })).toHaveCount(0)
}

test("61 an app plugin's surface page opens from the sidebar, draws natively in the app's document, and answers its button, its images, its input events and its board moves", async ({ stack, app, isMobile }) => {
  await stack.daemon.makeWorkspace("surface-page", "Surface project")
  expect(await registerLivePlugin(stack.url, await writeSurfaceFixturePlugin(stack.dataDir))).toMatchObject({ id: "surface-fixture", status: "ready" })
  const requested: string[] = []
  app.on("request", (request) => requested.push(request.url()))

  await app.goto(`${stack.url}/settings/app-plugins`)
  await approveAppPlugin(app, `Turn on the app plugin ${SURFACE_FIXTURE_NAME}?`, APP_PLUGIN_WARNING.web)
  await expect(appPluginRow(app, SURFACE_FIXTURE_NAME)).toContainText("On")

  await app.goto(stack.url)
  await openFixtureFromRail(app, isMobile)
  await expect(app).toHaveURL(new RegExp(`${SURFACE_FIXTURE_PATH}$`))

  const surface = app.locator('[data-component="surface"][data-source="plugin"]')
  await expect(surface).toBeVisible()
  await expect(surface.locator('[data-slot="surface-source"]')).toHaveText(`${SURFACE_FIXTURE_NAME} · app plugin`)
  await expect(surface.getByRole("heading", { name: SURFACE_FIXTURE_NAME })).toBeVisible()
  await expect(surface.getByText("First item", { exact: true })).toBeVisible()
  await expect(surface.locator("iframe")).toHaveCount(0)
  await expect(app.getByTitle(SURFACE_FIXTURE_NAME, { exact: true })).toHaveCount(0)

  await surface.getByRole("textbox", { name: "Search items" }).fill("Typed by the reader")
  await surface.getByRole("button", { name: "Add item" }).click()
  await expect(surface.getByText("Typed by the reader", { exact: true })).toBeVisible()
  await expect(surface.getByText("First item", { exact: true })).toBeVisible()

  const picture = surface.getByRole("img", { name: "Fixture swatch" })
  await expect(picture).toHaveAttribute("data-slot", "surface-image")
  await expect.poll(() => picture.evaluate((image: HTMLImageElement) => (image.complete ? image.naturalWidth : 0))).toBe(16)
  const remote = surface.getByRole("img", { name: "Remote picture" })
  await expect(remote).toHaveAttribute("data-slot", "surface-image-refused")
  await expect(remote).toContainText("Remote picture")
  expect(requested.filter((url) => url.startsWith(new URL(SURFACE_FIXTURE_REMOTE_PICTURE).origin))).toEqual([])

  await expect(surface.getByText("Ordered oldest first", { exact: true })).toBeVisible()
  await surface.getByRole("button", { name: "Newest", exact: true }).click()
  await expect(surface.getByText("The plugin ordered by newest", { exact: true })).toBeVisible()

  await moveCardsOnTheBoard(surface, isMobile)
  expect((await listLivePlugins(stack.url)).plugins).toEqual([expect.objectContaining({ id: "surface-fixture", status: "ready" })])
})
