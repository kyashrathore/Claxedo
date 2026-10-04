import type { Locator, Page } from "@playwright/test"
import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, UI, watchPageWork, type ClaxedoApi, type SessionRow, type Stack, type Workspace } from "../harness"

type ListItem = { readonly sessionId: string; readonly title: string; readonly archivedAt?: number | null; readonly parentSessionId?: string | null }

async function serverOrder(url: string): Promise<string[]> {
  const target = new URL("/api/claxedo/session-list", url)
  for (const [key, value] of Object.entries({ scope: "workspace", sort: "human_turn_desc", limit: "50" })) target.searchParams.set(key, value)
  const response = await fetch(target)
  expect(response.status).toBe(200)
  const items = ((await response.json()) as { items: ListItem[] }).items
  return items.filter((item) => !item.archivedAt && !item.parentSessionId).map((item) => item.title)
}

async function serverSeenAt(url: string, workspaceId: string, title: string): Promise<number | undefined> {
  const target = new URL("/api/claxedo/session-list", url)
  for (const [key, value] of Object.entries({ scope: "workspace", workspaceId, sort: "human_turn_desc", limit: "50" })) target.searchParams.set(key, value)
  const items = ((await (await fetch(target)).json()) as { items: Array<ListItem & { seenAt?: number }> }).items
  return items.find((item) => item.title === title)?.seenAt
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

async function sessionAction(stack: Stack, app: Page, workspace: Workspace, session: SessionRow, action: string): Promise<void> {
  await test.step(`${action} from the rail row's menu, no title bar (DECISIONS Owner, 17:15)`, async () => {
    await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: session.title, exact: true }).click({ button: "right" })
    await app.getByRole("menuitem", { name: action }).click()
  })
  return
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await app.getByRole("main").getByRole("button", { name: "More options" }).click()
  await app.getByRole("menuitem", { name: action }).click()
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

test("10 session list: the project's rows, live status and rename, read back from the server", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("list", "List")
  const create = (title: string) => api.createSession(workspace.directory, { title, harness: SCRIPTED_ACP_HARNESS })
  await create("Alpha")
  const bravo = await create("Bravo")
  const charlie = await create("Charlie")

  await app.goto(`${stack.url}/`)
  await expect.poll(() => rowTitles(app)).toEqual(await serverOrder(stack.url))

  await liveStatus(stack, api, app, workspace.directory, bravo)

  await sessionAction(stack, app, workspace, charlie, "Rename")
  const editor = app.locator("input:focus, [role=textbox]:focus").and(app.locator(":not([contenteditable])"))
  await expect(editor).toHaveValue("Charlie")
  await editor.fill("Charlie renamed")
  await editor.press("Enter")
  await expect(row(app, "Charlie renamed")).toBeVisible()
  await expect.poll(async () => (await api.session(workspace.directory, charlie.id)).title).toBe("Charlie renamed")

  await expect.poll(() => rowTitles(app)).toEqual(await serverOrder(stack.url))
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

test("10 a finished dot survives a reload and a daemon restart, clears once the reader opens the session, and stays cleared, as the server records", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("seen", "Seen")
  const create = (title: string) => api.createSession(workspace.directory, { title, harness: SCRIPTED_ACP_HARNESS })
  const other = await create("Other")
  const finished = await create("Finished")
  await stack.acp.write("finished", { steps: [{ kind: "text", text: "The finished reply." }] })
  const rail = app.getByRole("navigation", { name: UI.rail })
  const mark = row(app, "Finished").locator("[data-sidebar-status]")
  const lastTurn = async () => (await api.session(workspace.directory, finished.id)).lastTurn as { completedAt?: number } | undefined

  await app.goto(`${stack.url}${sessionRoute(workspace.id, other.id)}`)
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  await api.promptAsync(workspace.directory, finished.id, `Say it. ${acpScriptToken("finished")}`)
  await expect.poll(async () => (await lastTurn())?.completedAt).toBeGreaterThan(0)
  await expect(mark).toHaveAttribute("data-sidebar-status", "done")

  await app.reload()
  await expect(mark).toHaveAttribute("data-sidebar-status", "done")
  await stack.daemon.restart()
  await app.reload()
  await expect(mark).toHaveAttribute("data-sidebar-status", "done")
  expect(await serverSeenAt(stack.url, workspace.id, "Finished")).toBeUndefined()

  await rail.getByRole("button", { name: "Finished", exact: true }).click()
  await expect(app.getByText("The finished reply.")).toBeVisible()
  await expect(mark).toHaveCount(0)
  await expect.poll(() => serverSeenAt(stack.url, workspace.id, "Finished")).toBe((await lastTurn())?.completedAt)

  await rail.getByRole("button", { name: "Other", exact: true }).click()
  await expect(app).toHaveURL(new RegExp(other.id))
  await app.reload()
  await expect(row(app, "Finished")).toBeVisible()
  await expect(mark).toHaveCount(0)
})
