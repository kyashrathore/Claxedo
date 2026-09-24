import type { Locator, Page } from "@playwright/test"
import { acpScriptToken, ApiError, assistantText, expect, SCRIPTED_ACP_HARNESS, test, type ClaxedoApi, type SessionRow, type Stack } from "../harness"

type ListItem = {
  readonly sessionId: string
  readonly title: string
  readonly lastHumanTurnAt?: number | null
  readonly archivedAt?: number | null
  readonly parentSessionId?: string | null
}

async function createProject(url: string, name: string, directory: string): Promise<void> {
  const response = await fetch(new URL("/api/claxedo/projects", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, source: { kind: "directory", directory } }),
  })
  expect(response.status).toBe(201)
}

async function serverList(url: string): Promise<ListItem[]> {
  const target = new URL("/api/claxedo/session-list", url)
  for (const [key, value] of Object.entries({ scope: "workspace", sort: "human_turn_desc", limit: "50" })) target.searchParams.set(key, value)
  const response = await fetch(target)
  expect(response.status).toBe(200)
  return ((await response.json()) as { items: ListItem[] }).items
}

async function serverOrder(url: string): Promise<string[]> {
  return (await serverList(url)).filter((item) => !item.archivedAt && !item.parentSessionId).map((item) => item.title)
}

async function sessionStatusCode(api: ClaxedoApi, directory: string, id: string): Promise<number> {
  return api.session(directory, id).then(
    () => 200,
    (error: unknown) => (error instanceof ApiError ? error.status : 0),
  )
}

function sessionList(app: Page): Locator {
  return app.getByRole("region", { name: "Sessions" })
}

function rows(app: Page): Locator {
  return sessionList(app).getByRole("listitem")
}

function row(app: Page, title: string): Locator {
  return rows(app).filter({ hasText: new RegExp(`^${title}$`) })
}

async function expectServerOrder(app: Page, url: string): Promise<void> {
  const order = await serverOrder(url)
  await expect(rows(app)).toHaveText(order)
}

async function rowAction(app: Page, title: string, action: string): Promise<void> {
  await sessionList(app).getByRole("button", { name: `Actions for ${title}` }).click()
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
  await api.promptAsync(directory, session.id, `Edit the README. ${acpScriptToken("live")}`)
  await expect(row(app, "Bravo").getByRole("img", { name: "Working" })).toBeVisible()
  await stack.acp.release("live")
  await expect(row(app, "Bravo").getByRole("img", { name: "Waiting on you" })).toBeVisible()
  const pending = (await api.permissions(directory)).filter((permission) => permission.sessionID === session.id)
  expect(pending).toHaveLength(1)
  await api.replyPermission(directory, session.id, pending[0].id, "once")
  await expect(row(app, "Bravo").getByRole("img", { name: "Idle" })).toBeVisible()
  expect(assistantText(await api.messages(directory, session.id))).toContain("Edited the README.")
}

async function renameAndSearch(api: ClaxedoApi, app: Page, directory: string, session: SessionRow): Promise<void> {
  await rowAction(app, "Charlie", "Rename")
  const dialog = app.getByRole("dialog")
  await dialog.getByRole("textbox", { name: "Session title" }).fill("Charlie renamed")
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(row(app, "Charlie renamed")).toBeVisible()
  await expect.poll(async () => (await api.session(directory, session.id)).title).toBe("Charlie renamed")
  const search = sessionList(app).getByRole("searchbox", { name: "Search sessions" })
  await search.fill("renamed")
  await expect(rows(app)).toHaveText(["Charlie renamed"])
  await search.fill("")
  await expect(rows(app)).toHaveCount(3)
}

test("10 session list: flat order, live status, rename, search, archive and delete, read back from the server", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("list")
  await createProject(stack.url, "List", workspace.directory)
  const create = (title: string) => api.createSession(workspace.directory, { title, harness: SCRIPTED_ACP_HARNESS })
  const alpha = await create("Alpha")
  const bravo = await create("Bravo")
  const charlie = await create("Charlie")

  await app.goto(`${stack.url}/`)
  await expect(rows(app)).toHaveCount(3)
  await expectServerOrder(app, stack.url)

  await liveStatus(stack, api, app, workspace.directory, bravo)
  await expectServerOrder(app, stack.url)
  await renameAndSearch(api, app, workspace.directory, charlie)

  await rowAction(app, "Alpha", "Archive")
  await expect(row(app, "Alpha")).toHaveCount(0)
  await expect.poll(async () => (await api.session(workspace.directory, alpha.id)).time.archived ?? 0).toBeGreaterThan(0)

  await rowAction(app, "Bravo", "Delete")
  await app.getByRole("dialog").getByRole("button", { name: "Delete session" }).click()
  await expect(row(app, "Bravo")).toHaveCount(0)
  await expect.poll(() => sessionStatusCode(api, workspace.directory, bravo.id)).toBe(404)

  expect(await serverOrder(stack.url)).toEqual(["Charlie renamed"])
  await expectServerOrder(app, stack.url)
})
