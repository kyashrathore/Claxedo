import type { Page } from "@playwright/test"
import { acpScriptToken, expect, SCRIPTED_ACP_HARNESS, sendPrompt, sessionRoute, test, UI, type ClaxedoApi, type Stack } from "../harness"

const FILE = { type: "file", filename: "notes.txt", mime: "text/plain", url: "data:text/plain;base64,cXVldWVkIGZpbGU=" }
type Queued = { seq: number; messageId: string; held: boolean; parts: Array<Record<string, unknown>> }

async function arrange(stack: Stack, api: ClaxedoApi, app: Page) {
  const workspace = await stack.daemon.makeWorkspace("queue-edit")
  await stack.acp.write("queue-edit-held", { steps: [{ kind: "text", text: "Holding the active turn" }, { kind: "hold", name: "queue-edit-held" }] })
  const session = await api.createSession(workspace.directory, { harness: SCRIPTED_ACP_HARNESS, title: "Queue edits" })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await sendPrompt(app, `Hold. ${acpScriptToken("queue-edit-held")}`)
  await expect(app.getByText("Holding the active turn")).toBeVisible()
  const route = `${stack.url}/session/${session.id}`
  const query = `?directory=${encodeURIComponent(workspace.directory)}`
  const response = await app.request.post(`${route}/prompt_async${query}`, {
    data: { messageID: "msg_queue_edit", delivery: "queue", parts: [{ type: "text", text: "Queued original" }, FILE] },
  })
  expect(response.ok()).toBe(true)
  const queue = async (): Promise<Queued[]> => (await app.request.get(`${route}/queue${query}`)).json()
  expect(await queue()).toHaveLength(1)
  await app.reload()
  await expect(app.locator('[data-component="queued-message"]')).toContainText("Queued original")
  const editor = app.getByRole("textbox", { name: UI.composer })
  await editor.fill("Keep my unsent draft")
  return { workspace, session, route, query, queue, editor }
}

test("48 saving and cancelling queue edits preserve attachments and the unsent composer", async ({ stack, api, app }) => {
  const item = await arrange(stack, api, app)
  await app.locator('[data-component="queued-message"]').hover()
  await app.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(item.editor).toHaveText("Queued original")
  await item.editor.fill("Cancelled edit")
  await app.getByRole("button", { name: "Cancel edit", exact: true }).click()
  await expect(item.editor).toHaveText("Keep my unsent draft")
  expect((await item.queue())[0]?.parts).toContainEqual(FILE)
  await app.locator('[data-component="queued-message"]').hover()
  await app.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(item.editor).toHaveText("Queued original")
  await item.editor.fill("Saved queue edit")
  await item.editor.press("Enter")
  await expect(app.locator('[data-component="queued-message"]')).toContainText("Saved queue edit")
  await expect(item.editor).toHaveText("Keep my unsent draft")
  const queued = await item.queue()
  expect(queued).toHaveLength(1)
  expect(queued[0]).toMatchObject({ messageId: "msg_queue_edit", held: false })
  expect(queued[0]?.parts).toEqual([{ type: "text", text: "Saved queue edit" }, FILE])
  await app.reload()
  await expect(item.editor).toHaveText("Keep my unsent draft")
  await expect(app.locator('[data-component="queued-message"]')).toContainText("Saved queue edit")
})

test("48 a queued message removed by another client cannot turn its edit into a new send, and the edit stays in the composer", async ({ stack, api, app }) => {
  const item = await arrange(stack, api, app)
  await app.locator('[data-component="queued-message"]').hover()
  await app.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(item.editor).toHaveText("Queued original")
  await item.editor.fill("Do not duplicate this")
  const record = (await item.queue())[0]
  expect((await app.request.post(`${item.route}/queue/${record.seq}/cancel${item.query}`, { data: {} })).ok()).toBe(true)
  await expect.poll(async () => (await item.queue()).length).toBe(0)
  await item.editor.press("Enter")
  await expect(app.getByText(/The queued message .*your edit has not been sent/)).toBeVisible()
  await expect(app.getByRole("button", { name: "Cancel edit", exact: true })).toHaveCount(0)
  await expect(item.editor).toContainText("Keep my unsent draft")
  await expect(item.editor).toContainText("Do not duplicate this")
  expect(await item.queue()).toEqual([])
  const users = (await api.messages(item.workspace.directory, item.session.id)).filter((message) => message.info.role === "user")
  expect(users).toHaveLength(1)
  await item.editor.press("Enter")
  await expect.poll(async () => (await item.queue()).map((queued) => queued.parts[0]?.text)).toEqual(["Keep my unsent draft\n\nDo not duplicate this"])
})

test("48 a queued message that disappears while it is edited returns the edit to the session composer", async ({ stack, api, app }) => {
  const item = await arrange(stack, api, app)
  await item.editor.fill("")
  await app.locator('[data-component="queued-message"]').hover()
  await app.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(item.editor).toHaveText("Queued original")
  await item.editor.fill("Edited before it vanished")
  const record = (await item.queue())[0]
  expect((await app.request.post(`${item.route}/queue/${record.seq}/cancel${item.query}`, { data: {} })).ok()).toBe(true)
  await stack.acp.release("queue-edit-held")
  await expect(app.locator('[data-component="queued-message"]')).toHaveCount(0)
  await expect(app.getByRole("button", { name: "Cancel edit", exact: true })).toHaveCount(0)
  await expect(item.editor).toHaveText("Edited before it vanished")
  await item.editor.press("Enter")
  await expect.poll(async () => (await api.messages(item.workspace.directory, item.session.id)).filter((message) => message.info.role === "user").length).toBe(2)
  await expect(item.editor).toHaveText("")
})
