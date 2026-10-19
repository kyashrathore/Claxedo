import type { Locator, Page } from "@playwright/test"
import {
  APP_PLUGIN_WARNING,
  approveAppPlugin,
  appPluginRow,
  expect,
  expectNothingAnimating,
  listLivePlugins,
  registerLivePlugin,
  SURFACE_FIXTURE_IMAGE,
  SURFACE_FIXTURE_NAME,
  SURFACE_FIXTURE_NO_PROJECT,
  SURFACE_FIXTURE_PATH,
  SURFACE_FIXTURE_PICTURE,
  SURFACE_FIXTURE_REMOTE_PICTURE,
  SURFACE_FIXTURE_SETTINGS,
  storeSurfaceFixtureImage,
  test,
  UI,
  writeSurfaceFixturePlugin,
} from "../harness"

type FixtureStack = { readonly url: string; readonly dataDir: string }

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

async function openSurfaceFixture(stack: FixtureStack, app: Page, isMobile: boolean) {
  expect(await registerLivePlugin(stack.url, await writeSurfaceFixturePlugin(stack.dataDir))).toMatchObject({ id: "surface-fixture", status: "ready" })
  await app.goto(`${stack.url}/settings/app-plugins`)
  await approveAppPlugin(app, `Turn on the app plugin ${SURFACE_FIXTURE_NAME}?`, APP_PLUGIN_WARNING.web)
  await expect(appPluginRow(app, SURFACE_FIXTURE_NAME)).toContainText("On")
  await app.goto(stack.url)
  await expect(app).toHaveURL(/\/w\/[^/]+\/session$/)
  await openFixtureFromRail(app, isMobile)
  await expect(app).toHaveURL(new RegExp(`${SURFACE_FIXTURE_PATH}$`))
  const surface = app.locator('[data-component="surface"][data-source="plugin"]')
  await expect(surface).toBeVisible()
  return surface
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

async function attachAndSearch(surface: Locator) {
  const attachments = surface.getByRole("region", { name: "Attachments" })
  const input = attachments.getByRole("group", { name: "Attach images" }).locator('input[type="file"]')
  const swatch = Buffer.from(SURFACE_FIXTURE_PICTURE.slice(SURFACE_FIXTURE_PICTURE.indexOf(",") + 1), "base64")
  await input.setInputFiles({ name: "swatch.png", mimeType: "image/png", buffer: swatch })
  const preview = attachments.getByRole("img", { name: "swatch.png" })
  await expect(preview).toHaveAttribute("data-slot", "surface-image")
  await expect.poll(() => preview.evaluate((image: HTMLImageElement) => (image.complete ? image.naturalWidth : 0))).toBe(16)
  await expect(attachments.getByText("Nothing refused", { exact: true })).toBeVisible()
  await input.setInputFiles({ name: "big.png", mimeType: "image/png", buffer: Buffer.alloc(5000) })
  await expect(attachments.getByText("Refused big.png: size", { exact: true })).toBeVisible()

  const project = surface.getByRole("combobox", { name: "Project" })
  await project.fill("doc")
  await expect(surface.getByRole("option", { name: /^Docs site/ })).toBeVisible()
  await expect(surface.getByRole("option", { name: /^Claxedo app/ })).toHaveCount(0)
  await surface.getByRole("option", { name: /^Docs site/ }).click()
  await expect(surface.getByText("Chose docs", { exact: true })).toBeVisible()
  await expect(project).toHaveValue("Docs site")
}

test("61 an app plugin's surface page opens from the sidebar, draws natively in the app's document, and answers its button, its images, its input events, its board moves, its picked files and its searched choices", async ({ stack, app, isMobile }) => {
  await stack.daemon.makeWorkspace("surface-page", "Surface project")
  const requested: string[] = []
  app.on("request", (request) => requested.push(request.url()))
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
  await attachAndSearch(surface)
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

test("61 a plugin tab page keeps its state when its route params change, and opens its own surface settings section", async ({ stack, app, isMobile }) => {
  await stack.daemon.makeWorkspace("surface-page", "Surface project")
  const surface = await openSurfaceFixture(stack, app, isMobile)
  await expect(app.getByTestId("shell-center")).toHaveAttribute("data-center", "panes")
  if (!isMobile) {
    await app.getByRole("button", { name: UI.hideSidebar }).click()
    await expect(app.getByRole("navigation", { name: "Workbench panes" }).getByRole("button", { name: SURFACE_FIXTURE_NAME, exact: true })).toBeVisible()
  }
  await expect(surface.getByText("Selected: none", { exact: true })).toBeVisible()

  await surface.getByRole("textbox", { name: "Search items" }).fill("Kept across params")
  await surface.getByRole("button", { name: "Add item" }).click()
  await expect(surface.getByText("Kept across params", { exact: true })).toBeVisible()
  await surface.getByRole("button", { name: "Select the first item" }).click()
  await expect(app).toHaveURL(new RegExp(`${SURFACE_FIXTURE_PATH}/first$`))
  await expect(surface.getByText("Selected: first", { exact: true })).toBeVisible()
  await expect(surface.getByText("Kept across params", { exact: true })).toBeVisible()

  await surface.getByRole("button", { name: "Open the fixture settings" }).click()
  await expect(app).toHaveURL(new RegExp(`/settings/${encodeURIComponent("surface-fixture/settings")}$`))
  const settings = app.locator('[data-component="surface"][data-source="plugin"]')
  await expect(settings.getByRole("heading", { name: `${SURFACE_FIXTURE_SETTINGS} body` })).toBeVisible()
  await expect(settings.locator('[data-slot="surface-source"]')).toHaveText(`${SURFACE_FIXTURE_NAME} · app plugin`)
  await expect(settings.locator('[data-action="prompt-harness-model"]')).toBeVisible()
  await expect(settings.getByText(/^Harness: (?!none$)\S+$/)).toBeVisible()
  expect((await listLivePlugins(stack.url)).plugins).toEqual([expect.objectContaining({ id: "surface-fixture", status: "ready" })])
})

test("61 a web plugin reads a binary response through its frame byte for byte", async ({ stack, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("surface-page", "Surface project")
  const image = await storeSurfaceFixtureImage(stack.url, workspace.projectId)
  const surface = await openSurfaceFixture(stack, app, isMobile)
  await surface.getByRole("textbox", { name: "Fetch path" }).fill(image.path)
  await surface.getByRole("button", { name: "Fetch bytes" }).click()
  const hex = Array.from(SURFACE_FIXTURE_IMAGE, (byte) => byte.toString(16).padStart(2, "0")).join(" ")
  await expect(surface.getByText(`200 image/png ${hex}`, { exact: true })).toBeVisible()
  expect(await image.read()).toEqual([expect.objectContaining({ mime: "image/png", size: SURFACE_FIXTURE_IMAGE.length })])
})
