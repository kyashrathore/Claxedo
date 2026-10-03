import type { Locator, Page } from "@playwright/test"
import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, sendPrompt, test, UI, type ClaxedoApi, type Stack } from "../harness"

type Listed = { readonly sessionId: string; readonly title: string; readonly settledAt?: number }

async function serverList(stack: Stack, settled: "active" | "all"): Promise<Listed[]> {
  const target = new URL("/api/claxedo/session-list", stack.url)
  for (const [key, value] of Object.entries({ scope: "all", sort: "human_turn_desc", limit: "50", settled })) target.searchParams.set(key, value)
  const response = await fetch(target)
  expect(response.status).toBe(200)
  return ((await response.json()) as { items: Listed[] }).items
}

async function serverTitles(stack: Stack, titles: readonly string[]): Promise<string[]> {
  return (await serverList(stack, "active")).map((item) => item.title).filter((title) => titles.includes(title))
}

function rail(app: Page): Locator {
  return app.getByRole("navigation", { name: UI.rail })
}

function row(app: Page, title: string): Locator {
  return rail(app).getByTestId("rail-sidebar-session-row").filter({ has: app.getByRole("button", { name: title, exact: true }) })
}

function rowTitles(app: Page, titles: readonly string[]): Promise<string[]> {
  return rail(app)
    .getByTestId("rail-sidebar-session-row")
    .locator('[data-slot="navigation-row-activate"]')
    .evaluateAll((buttons, wanted) => buttons.map((button) => button.getAttribute("aria-label") ?? "").filter((title) => wanted.includes(title)), titles)
}

async function showRail(app: Page, isMobile: boolean): Promise<void> {
  if (!isMobile) return
  const open = app.getByRole("button", { name: UI.openRail })
  if (await open.isVisible()) await open.tap()
  await expect(rail(app)).toBeVisible()
}

async function option(app: Page, isMobile: boolean, role: "menuitemradio" | "menuitemcheckbox", name: string): Promise<void> {
  await showRail(app, isMobile)
  await rail(app).getByRole("button", { name: "Session options" }).click()
  await app.getByRole(role, { name }).click()
  if (role === "menuitemcheckbox") await app.keyboard.press("Escape")
}

async function rowAction(app: Page, isMobile: boolean, title: string, action: string): Promise<void> {
  if (!isMobile) await row(app, title).hover()
  await row(app, title).getByRole("button", { name: action, exact: true }).click()
}

async function sessions(stack: Stack, api: ClaxedoApi, specs: ReadonlyArray<readonly [string, string]>) {
  const workspaces = new Map<string, Awaited<ReturnType<Stack["daemon"]["makeWorkspace"]>>>()
  const made: Record<string, { readonly id: string; readonly directory: string }> = {}
  for (const [project, title] of specs) {
    const workspace = workspaces.get(project) ?? (await stack.daemon.makeWorkspace(project.toLowerCase(), project))
    workspaces.set(project, workspace)
    const session = await api.createSession(workspace.directory, { title, harness: SCRIPTED_ACP_HARNESS })
    made[title] = { id: session.id, directory: workspace.directory }
  }
  return made
}

test("49 Activity lists every project's sessions in one order, the reader's send moves a row, and Settle, Show settled and Return work in both views", async ({ stack, api, app, isMobile }) => {
  const titles = ["One", "Two", "Three"]
  const made = await sessions(stack, api, [["Alpha", "One"], ["Bravo", "Two"], ["Alpha", "Three"]])
  await stack.acp.write("held", { steps: [{ kind: "hold", name: "held" }, { kind: "text", text: "Held reply." }] })

  await app.goto(`${stack.url}/`)
  await option(app, isMobile, "menuitemradio", "Activity")
  await showRail(app, isMobile)
  await expect(rail(app).getByRole("heading", { name: "Activity" })).toBeVisible()
  await expect.poll(() => rowTitles(app, titles)).toEqual(await serverTitles(stack, titles))
  await expect(row(app, "Two")).toContainText("Bravo")

  await row(app, "One").getByRole("button", { name: "One", exact: true }).click()
  await sendPrompt(app, `Hold on. ${acpScriptToken("held")}`)
  await showRail(app, isMobile)
  await expect.poll(() => rowTitles(app, titles)).toEqual(["One", "Three", "Two"])
  await stack.acp.release("held")
  await expect.poll(async () => assistantText(await api.messages(made.One!.directory, made.One!.id))).toContain("Held reply.")

  if (!isMobile) {
    await row(app, "Two").click({ button: "right" })
    const menu = app.getByRole("menu")
    await expect(menu.getByRole("menuitem", { name: "Settle" })).toBeVisible()
    await expect(menu.getByRole("menuitem", { name: /Archive|Delete/ })).toHaveCount(0)
    const viewport = app.viewportSize()
    await app.mouse.click((viewport?.width ?? 800) - 4, (viewport?.height ?? 600) - 4)
    await expect(menu).toHaveCount(0)
  }

  await rowAction(app, isMobile, "Two", "Settle Two")
  await expect(row(app, "Two")).toHaveCount(0)
  await expect.poll(async () => (await serverList(stack, "active")).some((item) => item.sessionId === made.Two!.id)).toBe(false)

  await option(app, isMobile, "menuitemcheckbox", "Show settled")
  await showRail(app, isMobile)
  await expect(row(app, "Two")).toBeVisible()
  await option(app, isMobile, "menuitemradio", "Projects")
  await showRail(app, isMobile)
  await expect(rail(app).getByRole("heading", { name: "Projects" })).toBeVisible()
  await expect(row(app, "Two")).toBeVisible()

  await rowAction(app, isMobile, "Two", "Return Two to active")
  await expect.poll(async () => (await serverList(stack, "all")).find((item) => item.sessionId === made.Two!.id)?.settledAt).toBeUndefined()
  await option(app, isMobile, "menuitemcheckbox", "Show settled")
  await showRail(app, isMobile)
  await expect(row(app, "Two")).toBeVisible()
})

test("49 a session settled in Projects stays hidden after a reload, and its next turn result returns it", async ({ stack, api, app, isMobile }) => {
  const made = await sessions(stack, api, [["Settling", "Quiet"], ["Settling", "Later"]])
  await stack.acp.write("result", { steps: [{ kind: "text", text: "A new result." }] })

  await app.goto(`${stack.url}/`)
  await showRail(app, isMobile)
  await expect(row(app, "Quiet")).toBeVisible()
  await rowAction(app, isMobile, "Quiet", "Settle Quiet")
  await expect(row(app, "Quiet")).toHaveCount(0)

  await app.reload()
  await showRail(app, isMobile)
  await expect(row(app, "Later")).toBeVisible()
  await expect(row(app, "Quiet")).toHaveCount(0)
  expect((await serverList(stack, "all")).find((item) => item.sessionId === made.Quiet!.id)?.settledAt).toEqual(expect.any(Number))

  await api.promptAsync(made.Quiet!.directory, made.Quiet!.id, `Say something. ${acpScriptToken("result")}`)
  await expect(row(app, "Quiet")).toBeVisible()
  await expect.poll(async () => (await serverList(stack, "active")).some((item) => item.sessionId === made.Quiet!.id)).toBe(true)
})

test("49 hidden working statuses show on hover, the Activity filter cycles Working and Needs you, and an opened result's dot stays cleared after a reload", async ({ stack, api, app, isMobile }) => {
  test.skip(isMobile, "hover reveal and the filter run at desktop width")
  const titles = ["Busy", "Done", "Calm"]
  const made = await sessions(stack, api, [["Filters", "Calm"], ["Filters", "Done"], ["Filters", "Busy"]])
  await stack.acp.write("done", { steps: [{ kind: "text", text: "Finished work." }] })
  await stack.acp.write("busy", { steps: [{ kind: "hold", name: "busy" }, { kind: "text", text: "Busy reply." }] })
  await api.promptAsync(made.Done!.directory, made.Done!.id, `Finish. ${acpScriptToken("done")}`)
  await expect.poll(async () => ((await api.session(made.Done!.directory, made.Done!.id)).lastTurn as { status?: string } | undefined)?.status).toBe("completed")

  await app.goto(`${stack.url}/`)
  await option(app, false, "menuitemradio", "Activity")
  await option(app, false, "menuitemcheckbox", "Hide working statuses")
  await api.promptAsync(made.Busy!.directory, made.Busy!.id, `Work. ${acpScriptToken("busy")}`)
  const working = row(app, "Busy").locator('[data-sidebar-status="working"]')
  await expect(working).toHaveCount(1)
  await expect(working).toBeHidden()
  await row(app, "Busy").hover()
  await expect(working).toBeVisible()
  await rail(app).getByRole("heading", { name: "Activity" }).hover()
  await expect(working).toBeHidden()

  await rail(app).getByRole("button", { name: "Show working sessions" }).click()
  await expect(rail(app).getByRole("heading", { name: "Working" })).toBeVisible()
  await expect.poll(() => rowTitles(app, titles)).toEqual(["Busy"])
  await rail(app).getByRole("button", { name: "Show sessions that need you" }).click()
  await expect(rail(app).getByRole("heading", { name: "Needs you" })).toBeVisible()
  await expect.poll(() => rowTitles(app, titles)).toEqual(["Done"])
  await option(app, false, "menuitemcheckbox", "Hide working statuses")
  await expect(rail(app).getByRole("heading", { name: "Activity" })).toBeVisible()
  await expect.poll(() => rowTitles(app, titles)).toEqual(["Busy", "Done", "Calm"])
  await stack.acp.release("busy")

  const dot = row(app, "Done").locator("[data-sidebar-status]")
  await expect(dot).toHaveAttribute("data-sidebar-status", "done")
  await row(app, "Done").getByRole("button", { name: "Done", exact: true }).click()
  await expect(app.getByText("Finished work.")).toBeVisible()
  await expect(dot).toHaveCount(0)
  await app.reload()
  await expect(rail(app).getByRole("heading", { name: "Activity" })).toBeVisible()
  await expect(row(app, "Done")).toBeVisible()
  await expect(dot).toHaveCount(0)
})
