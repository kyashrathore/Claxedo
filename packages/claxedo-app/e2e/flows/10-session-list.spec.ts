import type { Locator, Page } from "@playwright/test"
import { activitySidebar, virtualActivitySidebar } from "../harness/activity-sidebar"
import { sidebarFilter } from "../harness/sidebar-filter"
import { sessionRowPresentation } from "../harness/sidebar-row-presentation"
import { sessionRowSurfaceRefinement } from "../harness/sidebar-row-surface"
import { coarseFilterChoices, coarseFooterTargets, shortActivityViewport, sidebarSectionFilter } from "../harness/activity-layout"
import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, UI, watchPageWork, type ClaxedoApi, type SessionRow, type Stack } from "../harness"

type ListItem = { readonly sessionId: string; readonly title: string; readonly archivedAt?: number | null; readonly parentSessionId?: string | null; readonly attention?: { readonly activitySequence: number }; readonly reader?: { readonly settledThrough?: number } }

async function serverRows(url: string, settled: "active" | "settled" = "active"): Promise<ListItem[]> {
  const target = new URL("/api/claxedo/session-list", url)
  for (const [key, value] of Object.entries({ scope: "all", sort: "human_turn_desc", limit: "50", settled })) target.searchParams.set(key, value)
  const response = await fetch(target)
  expect(response.status).toBe(200)
  const items = ((await response.json()) as { items: ListItem[] }).items
  return items.filter((item) => !item.archivedAt && !item.parentSessionId)
}

async function serverOrder(url: string): Promise<string[]> {
  return (await serverRows(url)).map((row) => row.title)
}

function rows(app: Page): Locator {
  return app.getByTestId("rail-sidebar-session-row")
}

function row(app: Page, title: string): Locator {
  return rows(app).filter({ has: app.getByRole("button", { name: title, exact: true }) })
}

function rowTitles(app: Page): Promise<string[]> {
  return rows(app).locator('[data-slot="navigation-row-activate"]').evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? ""))
}

async function sessionAction(app: Page, session: SessionRow, action: string): Promise<void> {
  await test.step(`${action} from the rail row's menu, no title bar (DECISIONS Owner, 17:15)`, async () => {
    await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: session.title, exact: true }).click({ button: "right" })
    await app.getByRole("menuitem", { name: action }).click()
  })
}

async function liveStatus(stack: Stack, api: ClaxedoApi, app: Page, directory: string, session: SessionRow): Promise<void> {
  await stack.acp.write("live", {
    steps: [
      { kind: "hold", name: "live" },
      { kind: "permission", tool: "edit", title: "Edit README.md", path: `${directory}/README.md` },
      { kind: "text", text: "Edited the README." },
    ],
  })
  const mark = row(app, "Bravo").locator("[data-sidebar-status]")
  await api.promptAsync(directory, session.id, `Edit the README. ${acpScriptToken("live")}`)
  await expect(mark).toHaveAttribute("data-sidebar-status", "working")
  await stack.acp.release("live")
  await expect(mark).toHaveAttribute("data-sidebar-status", "permission")
  const pending = (await api.permissions(directory)).filter((permission) => permission.sessionID === session.id)
  expect(pending).toHaveLength(1)
  await api.replyPermission(directory, session.id, pending[0].id, "once")
  await expect(row(app, "Bravo").locator('[data-sidebar-status="working"], [data-sidebar-status="permission"]')).toHaveCount(0)
  expect(assistantText(await api.messages(directory, session.id))).toContain("Edited the README.")
}

test.skip(({ isMobile }) => isMobile, "flow 10 runs at desktop width; flow 33 owns the phone rail")

test("10 session rows keep original Projects spacing and flat matching action surfaces", async ({ stack, api, app }, info) => {
  await sessionRowSurfaceRefinement(stack, api, app, false, info)
})

test("10 session rows keep quiet context, bounded tooltips and one finite overflow motion", async ({ stack, api, app }, testInfo) => {
  await sessionRowPresentation(stack, api, app, false, testInfo)
})

test("10 Activity lists active sessions in last-turn order with rich two-line rows", async ({ stack, api, app }, testInfo) => {
  await activitySidebar(stack, api, app, false, testInfo)
})

test("10 Activity virtualizes more than 100 loaded rows and keyboard navigation reveals both ends", async ({ stack, api, app }) => {
  await virtualActivitySidebar(stack, api, app)
})

test("10 a wide coarse pointer keeps settlement and placement controls at 44 pixels without overlapping rows", async ({ browser, stack, api }) => {
  const workspace = await stack.daemon.makeWorkspace("coarse", "Coarse pointer")
  await api.createSession(workspace.directory, { title: "First coarse session", harness: SCRIPTED_ACP_HARNESS })
  await api.createSession(workspace.directory, { title: "Second coarse session", harness: SCRIPTED_ACP_HARNESS })
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 }, hasTouch: true, isMobile: false })
  const app = await context.newPage()
  try {
    await app.goto(`${stack.url}/`)
    expect(await app.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true)
    await sidebarSectionFilter(app, true)
    await coarseFilterChoices(app)
    await coarseFooterTargets(app)
    await app.setViewportSize({ width: 1024, height: 982 })
    await coarseFilterChoices(app)
    await expect(rows(app)).toHaveCount(2)
    const boxes = await rows(app).evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()))
    expect(boxes[0]!.height).toBeGreaterThanOrEqual(44)
    expect(boxes[1]!.y).toBeGreaterThanOrEqual(boxes[0]!.y + boxes[0]!.height)
    await coarseControls(app, row(app, "First coarse session"))
    await sidebarFilter(app, "Activity")
    await coarseControls(app, app.getByTestId("activity-session-row").filter({ has: app.getByRole("button", { name: "First coarse session", exact: true }) }))
    await shortActivityViewport(app)
    await app.goto(`${stack.url}/settings/appearance`)
    await expect(app.getByRole("navigation", { name: UI.rail })).toHaveAttribute("data-mode", "settings")
    await expect(app.getByRole("button", { name: "Session options", exact: true })).toHaveCount(0)
  } finally { await context.close() }
})

async function coarseControls(app: Page, session: Locator): Promise<void> {
  const target = session.getByRole("button", { name: "Settle First coarse session", exact: true })
  await expect(target).toBeVisible()
  const box = await target.boundingBox()
  const frame = await session.boundingBox()
  const title = await session.getByText("First coarse session", { exact: true }).boundingBox()
  expect(box!.width).toBeGreaterThanOrEqual(44)
  expect(box!.height).toBeGreaterThanOrEqual(44)
  expect(box!.y).toBeGreaterThanOrEqual(frame!.y)
  expect(box!.y + box!.height).toBeLessThanOrEqual(frame!.y + frame!.height)
  expect(title!.x + title!.width).toBeLessThanOrEqual(box!.x)
  const placement = session.locator('[data-slot="activity-placement"]')
  if (await placement.count()) {
    const marker = await placement.boundingBox()
    expect(marker!.width).toBeGreaterThanOrEqual(44)
    expect(marker!.height).toBeGreaterThanOrEqual(44)
  }
  expect(await app.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
}

test("10 session list: rename and settle filter the reader's rows while retaining the open session", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("list", "List")
  const create = (title: string) => api.createSession(workspace.directory, { title, harness: SCRIPTED_ACP_HARNESS })
  const alpha = await create("Alpha")
  const bravo = await create("Bravo")
  const charlie = await create("Charlie")

  await app.goto(`${stack.url}/`)
  await expect.poll(() => rowTitles(app)).toEqual(await serverOrder(stack.url))
  await sidebarSectionFilter(app, false)
  await expect(app.getByRole("button", { name: "Activity", exact: true })).toHaveCount(0)
  await expect(app.getByRole("combobox", { name: "Session options" })).toHaveCount(0)
  const alphaRow = row(app, "Alpha")
  const checkmark = alphaRow.getByRole("button", { name: "Settle Alpha", exact: true })
  const bounds = await alphaRow.boundingBox()
  expect(bounds?.height).toBeLessThan(44)
  await app.mouse.move(900, 100)
  expect(await checkmark.evaluate((button) => button.checkVisibility({ checkOpacity: true }))).toBe(false)
  const titleWidth = await alphaRow.getByText("Alpha", { exact: true }).evaluate((title) => title.getBoundingClientRect().width)
  await alphaRow.getByRole("button", { name: "Alpha", exact: true }).focus()
  await expect.poll(() => checkmark.evaluate((button) => button.checkVisibility({ checkOpacity: true }))).toBe(true)
  expect(await alphaRow.getByText("Alpha", { exact: true }).evaluate((title) => title.getBoundingClientRect().width)).toBe(titleWidth)
  await checkmark.hover()
  const buttonSurface = await checkmark.evaluate((button) => ({ background: getComputedStyle(button).backgroundColor, outline: getComputedStyle(button).boxShadow }))
  expect(buttonSurface.background).not.toBe("rgba(0, 0, 0, 0)")
  expect(buttonSurface.outline).not.toBe("none")

  await liveStatus(stack, api, app, workspace.directory, bravo)

  await sessionAction(app, charlie, "Rename")
  const editor = app.locator("input:focus, [role=textbox]:focus").and(app.locator(":not([contenteditable])"))
  await expect(editor).toHaveValue("Charlie")
  await editor.fill("Charlie renamed")
  await editor.press("Enter")
  await expect(row(app, "Charlie renamed")).toBeVisible()
  await expect.poll(async () => (await api.session(workspace.directory, charlie.id)).title).toBe("Charlie renamed")

  await row(app, "Alpha").getByRole("button", { name: "Alpha", exact: true }).click()
  await expect(app).toHaveURL(new RegExp(alpha.id))
  const opened = app.url()
  await app.getByRole("button", { name: "Settle Alpha" }).click()
  await expect(row(app, "Alpha")).toHaveCount(0)
  await expect(app).toHaveURL(opened)
  await expect.poll(async () => (await serverRows(stack.url, "settled")).map((row) => row.title)).toEqual(["Alpha"])
  const settled = (await serverRows(stack.url, "settled"))[0]
  expect(settled.reader?.settledThrough).toBe(settled.attention?.activitySequence)
  expect((await api.session(workspace.directory, alpha.id)).time.archived).toBeUndefined()
  expect((await api.sessions(workspace.directory)).map((row) => row.id)).toContain(alpha.id)
  expect(await serverOrder(stack.url)).not.toContain("Alpha")

  await sidebarFilter(app, "Activity")
  await expect(app.getByTestId("activity-session-row").filter({ has: app.getByRole("button", { name: "Alpha", exact: true }) })).toHaveCount(0)
  await expect(app).toHaveURL(opened)
})

test("10 a background turn, in a session visited before, changes only its own rail row, wakes no animation frame, and leaves a finished dot until the reader opens it", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("isolation", "Isolation")
  const create = (title: string) => api.createSession(workspace.directory, { title, harness: SCRIPTED_ACP_HARNESS })
  const open = await create("Open")
  const background = await create("Background")
  await create("Third")
  const reply = Array.from({ length: 30 }, (_, index) => `Background paragraph ${index + 1}.`).join("\n\n")
  await stack.acp.write("background", { steps: [{ kind: "hold", name: "background" }, { kind: "text", text: `${reply}\n\nThe background reply ends here.`, chunks: 150, delayMs: 10 }] })

  await app.goto(`${stack.url}${sessionRoute(workspace.id, background.id)}`)
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: "Open", exact: true }).click()
  await expect(app).toHaveURL(new RegExp(open.id))
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  const mark = row(app, "Background").locator("[data-sidebar-status]")
  await api.promptAsync(workspace.directory, background.id, `Write at length. ${acpScriptToken("background")}`)
  await expect(mark).toHaveAttribute("data-sidebar-status", "working")
  const work = await watchPageWork(app, { regions: { ownRow: `[data-testid="rail-sidebar-session-row"][data-session-id="${background.id}"]` } })
  await stack.acp.release("background")
  await expect.poll(async () => assistantText(await api.messages(workspace.directory, background.id))).toContain("The background reply ends here.")
  await expect(mark).toHaveAttribute("data-sidebar-status", "done")

  const seen = await work()
  expect(seen.animationFrames, "animation frames asked for during the background turn").toBe(0)
  expect(Object.keys(seen.mutations), "regions the background turn changed").toEqual(["ownRow"])

  await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: "Background", exact: true }).click()
  await expect(app.getByText("The background reply ends here.")).toBeVisible()
  await expect(mark).toHaveCount(0)
})


test("10 a failed turn's dot clears once the reader opens the session, stays cleared after a reload, and returns for the next failure", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("unseen", "Unseen")
  const create = (title: string) => api.createSession(workspace.directory, { title, harness: SCRIPTED_ACP_HARNESS })
  const other = await create("Other")
  const greeting = await create("Greeting")
  await stack.acp.write("failing", { steps: [{ kind: "error", message: "Rate limit reached for requests" }] })
  const rail = app.getByRole("navigation", { name: UI.rail })
  const mark = row(app, "Greeting").locator("[data-sidebar-status]")
  const lastTurn = async () => (await api.session(workspace.directory, greeting.id)).lastTurn as { status?: string; completedAt?: number } | undefined

  await app.goto(`${stack.url}${sessionRoute(workspace.id, other.id)}`)
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  await api.promptAsync(workspace.directory, greeting.id, `Say hello. ${acpScriptToken("failing")}`)
  await expect.poll(async () => (await lastTurn())?.status).toBe("failed")
  await expect(mark).toHaveAttribute("data-sidebar-status", "error")

  await rail.getByRole("button", { name: "Greeting", exact: true }).click()
  await expect(app).toHaveURL(new RegExp(greeting.id))
  await expect(app.getByText("Rate limit reached for requests")).toBeVisible()
  await expect(mark).toHaveCount(0)

  await app.reload()
  await expect(app.getByText("Rate limit reached for requests")).toBeVisible()
  await expect(row(app, "Greeting")).toBeVisible()
  await expect(mark).toHaveCount(0)
  await rail.getByRole("button", { name: "Other", exact: true }).click()
  await expect(app).toHaveURL(new RegExp(other.id))
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  await expect(mark).toHaveCount(0)

  const seen = (await lastTurn())?.completedAt
  await api.promptAsync(workspace.directory, greeting.id, `Say hello again. ${acpScriptToken("failing")}`)
  await expect.poll(async () => (await lastTurn())?.completedAt).not.toBe(seen)
  await expect(mark).toHaveAttribute("data-sidebar-status", "error")
})
