import type { Page } from "@playwright/test"
import { apiRequests, expect, expectNothingAnimating, SCRIPTED_ACP_HARNESS, sessionRoute, test, UI } from "../harness"

function panes(app: Page) {
  return app.getByRole("navigation", { name: "Workbench panes" })
}

function divider(app: Page) {
  return app.getByRole("separator", { name: "Resize panes" })
}

async function dragRowToRightEdge(app: Page, title: string) {
  const row = await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: title, exact: true }).boundingBox()
  const bench = await app.getByRole("main").boundingBox()
  if (!row || !bench) throw new Error("The rail row or the workbench has no box")
  await app.mouse.move(row.x + row.width / 2, row.y + row.height / 2)
  await app.mouse.down()
  await app.mouse.move(row.x + row.width / 2 + 30, row.y + row.height / 2 + 20, { steps: 4 })
  await app.mouse.move(bench.x + bench.width - 12, bench.y + bench.height / 2, { steps: 12 })
  await app.mouse.up()
}

test.skip(({ isMobile }) => isMobile, "flow 12 runs at desktop width; flow 33 covers the phone")

test("12 workbench and shell: a rail row dragged to the edge splits, compact tabs, close a pane and a tab, the palette", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("bench", "Bench")
  const first = await api.createSession(workspace.directory, { title: "First", harness: SCRIPTED_ACP_HARNESS })
  await api.createSession(workspace.directory, { title: "Second", harness: SCRIPTED_ACP_HARNESS })

  await app.goto(`${stack.url}${sessionRoute(workspace.id, first.id)}`)
  await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: "Second", exact: true }).click()
  await expect(divider(app)).toHaveCount(0)
  await dragRowToRightEdge(app, "First")
  await expect(divider(app)).toBeVisible()
  await expect(app.getByRole("button", { name: "Close Pane" })).toHaveCount(2)

  await app.getByRole("button", { name: UI.hideSidebar }).click()
  await expect(panes(app).getByRole("button", { name: "First", exact: true })).toBeVisible()
  await expect(panes(app).getByRole("button", { name: "Second", exact: true })).toBeVisible()

  await app.getByRole("button", { name: "Close Pane" }).first().click()
  await expect(divider(app)).toHaveCount(0)

  await panes(app).getByRole("button", { name: "Close First" }).click()
  await expect(panes(app).getByRole("button", { name: "First", exact: true })).toHaveCount(0)
  await expect(panes(app).getByRole("button", { name: "Second", exact: true })).toBeVisible()
  expect((await api.session(workspace.directory, first.id)).title).toBe("First")

  await app.keyboard.press("ControlOrMeta+Shift+KeyP")
  await expect(app.getByRole("dialog", { name: UI.palette })).toBeVisible()
  await app.keyboard.press("Escape")
  await expect(app.getByRole("dialog", { name: UI.palette })).toHaveCount(0)
})

async function domWritesDuring(app: Page, act: () => Promise<void>): Promise<string[]> {
  await app.evaluate(() => {
    const writes: string[] = []
    Object.assign(window, { resizeWrites: writes })
    new MutationObserver((records) => {
      for (const record of records) writes.push(`${record.type} ${(record.target as Element).tagName ?? record.target.nodeName} ${record.attributeName ?? ""}`)
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  })
  await act()
  await app.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  return app.evaluate(() => (window as unknown as { resizeWrites: string[] }).resizeWrites)
}

test("12 a narrow workbench shows one split pane without chrome, and a resize of an unsplit one writes nothing", async ({ stack, api, app }) => {
  await app.setViewportSize({ width: 1280, height: 800 })
  const workspace = await stack.daemon.makeWorkspace("narrow", "Narrow")
  const first = await api.createSession(workspace.directory, { title: "First", harness: SCRIPTED_ACP_HARNESS })
  await api.createSession(workspace.directory, { title: "Second", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, first.id)}`)
  await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: "Second", exact: true }).click()
  await dragRowToRightEdge(app, "First")
  await expect(divider(app)).toBeVisible()
  await expect(app.getByRole("button", { name: "Close Pane" })).toHaveCount(2)

  await app.setViewportSize({ width: 900, height: 800 })
  await expect(divider(app)).toBeHidden()
  await expect(app.getByRole("button", { name: "Close Pane" })).toHaveCount(0)
  await app.setViewportSize({ width: 1280, height: 800 })
  await expect(divider(app)).toBeVisible()
  await expect(app.getByRole("button", { name: "Close Pane" })).toHaveCount(2)

  await app.getByRole("button", { name: "Close Pane" }).first().click()
  await expect(divider(app)).toHaveCount(0)
  const writes = await domWritesDuring(app, async () => {
    await app.setViewportSize({ width: 900, height: 800 })
    await app.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await app.setViewportSize({ width: 1280, height: 800 })
  })
  expect(writes).toEqual([])
  expect((await api.session(workspace.directory, first.id)).title).toBe("First")
})

test("12 New Session again focuses the workspace's one draft tab", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("bench", "Bench")
  const first = await api.createSession(workspace.directory, { title: "First", harness: SCRIPTED_ACP_HARNESS })
  const draftTab = () => panes(app).getByRole("button", { name: /^New [Ss]ession$/ })

  await app.goto(`${stack.url}${sessionRoute(workspace.id, first.id)}`)
  const newSession = () => app.getByRole("main").getByRole("button", { name: UI.newSession, exact: true }).last()
  await newSession().click()
  await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: "First", exact: true }).click()
  await newSession().click()
  await app.getByRole("button", { name: UI.hideSidebar }).click()
  await expect(panes(app).getByRole("button", { name: "First", exact: true })).toBeVisible()
  await expect(draftTab()).toHaveCount(1)
})

test("12 closing every tab leaves the workspace's new-session composer, and New Session keeps it", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("bench", "Bench")
  const first = await api.createSession(workspace.directory, { title: "First", harness: SCRIPTED_ACP_HARNESS })
  const composer = app.getByRole("textbox", { name: UI.composer })

  const newSession = () => app.getByRole("main").getByRole("button", { name: UI.newSession, exact: true }).last()

  await app.goto(`${stack.url}${sessionRoute(workspace.id, first.id)}`)
  await expect(composer).toBeVisible()
  await newSession().click()
  await app.getByRole("button", { name: UI.hideSidebar }).click()
  await panes(app).getByRole("button", { name: "Close First" }).click()
  await panes(app).getByRole("button", { name: /^Close New Session$/i }).click()

  await expect(composer).toBeVisible()
  await newSession().click()
  await expect(composer).toBeVisible()
  await expect(app).toHaveURL(new RegExp(`/w/${workspace.id}(/session)?$`))
})

test("12 a session opened from the new-session composer leaves nothing animating once it is shown", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("bench", "Bench")
  const first = await api.createSession(workspace.directory, { title: "First", harness: SCRIPTED_ACP_HARNESS })

  await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: "First", exact: true }).click()
  await expect(app).toHaveURL(new RegExp(`${first.id}$`))
  await expectNothingAnimating(app)
})

test("12 Tasks and Marketplace share one page tab that shows the last one opened", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("bench", "Bench")
  const first = await api.createSession(workspace.directory, { title: "First", harness: SCRIPTED_ACP_HARNESS })
  const pageTabs = () => panes(app).getByRole("button", { name: /^(Tasks|Marketplace)$/ })

  await app.goto(`${stack.url}${sessionRoute(workspace.id, first.id)}`)
  await app.getByTestId("sidebar-tasks-entry").click()
  await expect(app).toHaveURL(/\/tasks$/)
  await app.getByTestId("sidebar-marketplace-entry").click()
  await expect(app).toHaveURL(/\/marketplace$/)
  await app.getByTestId("sidebar-tasks-entry").click()
  await app.getByRole("button", { name: UI.hideSidebar }).click()
  await expect(pageTabs()).toHaveCount(1)
  await expect(pageTabs()).toHaveAccessibleName("Tasks")

  await panes(app).getByRole("button", { name: "First", exact: true }).click()
  await expect(app).toHaveURL(new RegExp(`/${first.id}$`))
  await pageTabs().click()
  await expect(app).toHaveURL(/\/tasks$/)
})

test("12 a boot reads neither Tasks nor pi's provider catalog, an open reads each thing once, and a revisit reads nothing", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("reads", "Reads")
  await api.createSession(workspace.directory, { title: "Alpha", harness: SCRIPTED_ACP_HARNESS })
  await api.createSession(workspace.directory, { title: "Beta", harness: SCRIPTED_ACP_HARNESS })
  await app.goto("about:blank")
  const settled = apiRequests(app, stack.url)
  const rail = app.getByRole("navigation", { name: UI.rail })
  await app.goto(`${stack.url}/`)
  await expect(rail.getByRole("button", { name: "Beta", exact: true })).toBeVisible()
  const boot = await settled()
  expect(boot.filter((path) => path.startsWith("/api/claxedo/tasks/") || path === "/api/claxedo/agent-config/providers")).toEqual([])
  const open = async (title: string) => {
    await rail.getByRole("button", { name: title, exact: true }).click()
    await expect(app.getByRole("heading", { name: title, level: 1 })).toBeVisible()
    await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
    return settled()
  }
  for (const title of ["Alpha", "Beta"]) {
    const reads = await open(title)
    expect(reads.filter((path, index) => reads.indexOf(path) !== index), `${title} read twice`).toEqual([])
  }
  expect(await open("Alpha"), "revisiting Alpha").toEqual([])
  expect(await open("Beta"), "revisiting Beta").toEqual([])
  expect((await api.sessions(workspace.directory)).map((session) => session.title).sort()).toEqual(["Alpha", "Beta"])
})

test("12 opening a menu hides the page without touching each icon in the sprite", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("sprite", "Sprite")
  const session = await api.createSession(workspace.directory, { title: "Sprite", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  await expect.poll(() => app.evaluate(() => document.querySelectorAll("svg symbol").length)).toBeGreaterThan(20)
  await app.evaluate(() => {
    const writes: string[] = []
    new MutationObserver((records) => {
      for (const record of records) writes.push(record.target instanceof Element ? record.target.tagName.toLowerCase() : "?")
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["aria-hidden"] })
    Reflect.set(window, "__claxedoAriaHiddenWrites", writes)
  })
  const menu = app.getByRole("menu")
  await app.getByRole("button", { name: UI.signedOutAccount }).click()
  await expect(menu).toBeVisible()
  await app.keyboard.press("Escape")
  await expect(menu).toBeHidden()
  const writes = await app.evaluate(() => Reflect.get(window, "__claxedoAriaHiddenWrites") as string[])
  expect(writes.filter((tag) => tag === "symbol"), "aria-hidden writes on sprite symbols").toEqual([])
  expect(writes.length).toBeLessThanOrEqual(20)
})
