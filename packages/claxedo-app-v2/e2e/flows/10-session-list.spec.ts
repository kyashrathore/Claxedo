import type { Locator, Page } from "@playwright/test"
import { acpScriptToken, ApiError, assistantText, expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, UI, type ClaxedoApi, type SessionRow, type Stack, type Workspace } from "../harness"

type ListItem = { readonly sessionId: string; readonly title: string; readonly archivedAt?: number | null; readonly parentSessionId?: string | null }

async function serverOrder(url: string): Promise<string[]> {
  const target = new URL("/api/claxedo/session-list", url)
  for (const [key, value] of Object.entries({ scope: "workspace", sort: "human_turn_desc", limit: "50" })) target.searchParams.set(key, value)
  const response = await fetch(target)
  expect(response.status).toBe(200)
  const items = ((await response.json()) as { items: ListItem[] }).items
  return items.filter((item) => !item.archivedAt && !item.parentSessionId).map((item) => item.title)
}

async function sessionStatusCode(api: ClaxedoApi, directory: string, id: string): Promise<number> {
  return api.session(directory, id).then(
    () => 200,
    (error: unknown) => (error instanceof ApiError ? error.status : 0),
  )
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
  if (stack.app === "v2") {
    await test.step(`v2 approved: ${action} from the rail row's menu, no title bar (DECISIONS Owner, 17:15)`, async () => {
      await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: session.title, exact: true }).click({ button: "right" })
      await app.getByRole("menuitem", { name: action }).click()
    })
    return
  }
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

test("10 session list: the project's rows, live status, rename, archive and delete, read back from the server", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("list", "List")
  const create = (title: string) => api.createSession(workspace.directory, { title, harness: SCRIPTED_ACP_HARNESS })
  const alpha = await create("Alpha")
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

  await row(app, "Alpha").hover()
  await app.getByRole("button", { name: "Archive Alpha" }).click()
  await expect(row(app, "Alpha")).toHaveCount(0)
  await expect.poll(async () => (await api.session(workspace.directory, alpha.id)).time.archived ?? 0).toBeGreaterThan(0)

  await sessionAction(stack, app, workspace, bravo, "Delete")
  await app.getByRole("dialog").getByRole("button", { name: "Delete session" }).click()
  await expect(row(app, "Bravo")).toHaveCount(0)
  await expect.poll(() => sessionStatusCode(api, workspace.directory, bravo.id)).toBe(404)

  expect(await serverOrder(stack.url)).toEqual(["Charlie renamed"])
  await expect.poll(() => rowTitles(app)).toEqual(["Charlie renamed"])
})
