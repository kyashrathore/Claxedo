import type { Page } from "@playwright/test"
import { assistantText, expect, sendPrompt, sessionRoute, test, type ClaxedoApi, type MessageRow, type SessionHarness } from "../harness"

const PI: SessionHarness = { id: "pi", access: "native" }
const TITLE = "Release checklist"
const TOKEN = "SURFACESHOWN"

const RELEASE_SURFACE = {
  title: TITLE,
  components: [
    { id: "root", component: "Column", children: ["heading", "services", "name", "approve"] },
    { id: "heading", component: "Header", title: "Pending releases", icon: "upload", badges: ["count"] },
    { id: "count", component: "Badge", text: "2 services", variant: "warning" },
    { id: "services", component: "Section", title: "Services", child: "releases" },
    { id: "releases", component: "Table", columns: [{ key: "service", title: "Service" }, { key: "version", title: "Version" }], rows: { path: "/rows" } },
    { id: "name", component: "TextField", label: "Release name", value: { path: "/name" } },
    { id: "approve", component: "Button", child: "approve-label", variant: "primary", action: { event: { name: "approveRelease", context: { name: { path: "/name" } } } } },
    { id: "approve-label", component: "Text", text: "Approve" },
  ],
  data: { rows: [{ service: "api", version: "1.4.0" }, { service: "web", version: "2.0.1" }], name: "" },
}

function userTexts(messages: MessageRow[]) {
  return messages.filter((message) => message.info.role === "user").map((message) => message.parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join(""))
}

async function expectSurfacePainted(app: Page) {
  const surface = app.locator('[data-component="surface"][data-source="agent"]')
  await expect(surface).toBeVisible()
  await expect(surface.getByRole("heading", { name: "Pending releases" })).toBeVisible()
  await expect(surface.getByText("2 services", { exact: true })).toBeVisible()
  const table = surface.getByRole("region", { name: "Services" }).getByRole("table")
  await expect(table.getByRole("columnheader")).toHaveText(["Service", "Version"])
  await expect(table.getByRole("row").filter({ has: app.getByRole("cell") })).toHaveText([/api\s*1\.4\.0/, /web\s*2\.0\.1/])
  await expect(surface.locator('[data-slot="surface-source"]')).toBeVisible()
  return surface
}

async function sentTexts(api: ClaxedoApi, directory: string, sessionId: string) {
  return userTexts(await api.messages(directory, sessionId))
}

test("60 an agent's ui_show reply paints a native surface whose button, once confirmed, sends the typed value back as a message", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("surface-reply")
  const session = await api.createSession(workspace.directory, { title: "Surface reply", harness: PI })
  stack.scripted.scriptTool({ name: "mcp__claxedo__ui_show", input: RELEASE_SURFACE, whenPromptIncludes: TOKEN })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await sendPrompt(app, `Show the release checklist. Reply with exactly this one token: ${TOKEN}`)
  await expect.poll(async () => assistantText(await api.messages(workspace.directory, session.id)), { timeout: 30_000 }).toContain(TOKEN)

  const surface = await expectSurfacePainted(app)
  await expect(surface.locator('[data-slot="surface-source"]')).toHaveText("Pi")

  await surface.getByRole("textbox", { name: "Release name" }).fill("Spring release")
  await surface.getByRole("button", { name: "Approve" }).click()
  const confirm = app.getByRole("dialog", { name: "Send “approveRelease” to the agent?" })
  await expect(confirm).toContainText(`This sends the values from “${TITLE}” as a new message.`)
  const before = await sentTexts(api, workspace.directory, session.id)
  await confirm.getByRole("button", { name: "Cancel" }).click()
  await expect(confirm).toHaveCount(0)
  expect(await sentTexts(api, workspace.directory, session.id)).toEqual(before)

  await surface.getByRole("button", { name: "Approve" }).click()
  await confirm.getByRole("button", { name: "Send" }).click()
  await expect(confirm).toHaveCount(0)
  const sent = `Surface action "approveRelease" on "${TITLE}": {"name":"Spring release"}`
  await expect(app.locator('[data-component="user-message"]').filter({ hasText: sent })).toBeVisible()
  await expect.poll(() => sentTexts(api, workspace.directory, session.id)).toEqual([...before, sent])

  await app.reload()
  await expectSurfacePainted(app)
})
