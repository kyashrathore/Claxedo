import type { Page } from "@playwright/test"
import { expect, installedCli, sendPrompt, sessionRoute, test, UI, type HarnessFixtures, type MessageRow } from "../harness"

const CLAUDE = { id: "claude", access: "native" } as const

async function claudeSession(api: HarnessFixtures["api"], directory: string, title: string) {
  const availability = await installedCli("claude")
  test.skip(!availability.available, availability.available ? "" : availability.reason)
  return api.createSession(directory, { title, harness: CLAUDE })
}

async function sendCommand(app: Page, command: string) {
  await app.getByRole("textbox", { name: UI.composer }).click()
  await app.keyboard.type(`/${command}`)
  await app.keyboard.press("Escape")
  await expect(app.getByRole("listbox", { name: "Commands" })).toHaveCount(0)
  await app.keyboard.press("Enter")
}

function notices(messages: MessageRow[]) {
  return messages.flatMap((message) => message.parts).flatMap((part) => (part.type === "notice" ? [part.notice] : []))
}

test("44 a model request Claude retries shows as retrying, then the reply lands", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("notices-retry")
  const session = await claudeSession(api, workspace.directory, "Retry")
  const clear = stack.scripted.scriptError({ marker: "RETRIED", status: 429, message: "Rate limit reached for requests" })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await sendPrompt(app, "Reply with exactly this one token: RETRIED")

  await expect(app.getByText(/retrying/)).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => (await api.status(workspace.directory))[session.id]?.type).toBe("retry")
  clear()
  await expect(app.getByText("RETRIED", { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(app.getByText(/retrying/)).toHaveCount(0)
})

test("44 /compact draws the compaction boundary in the reply", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("notices-compact")
  const session = await claudeSession(api, workspace.directory, "Compact")
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await sendPrompt(app, "Reply with exactly this one token: BEFORECOMPACT")
  await expect(app.getByText("BEFORECOMPACT", { exact: true })).toBeVisible()

  await sendCommand(app, "compact")
  await expect(app.getByText("Session compacted")).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => notices(await api.messages(workspace.directory, session.id)))
    .toContainEqual({ kind: "compaction", status: "completed" })
})

test("44 /clear draws a boundary, keeps the earlier turns, and the next turn starts fresh", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("notices-clear")
  const session = await claudeSession(api, workspace.directory, "Clear")
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await sendPrompt(app, "Reply with exactly this one token: BEFORECLEAR")
  await expect(app.getByText("BEFORECLEAR", { exact: true })).toBeVisible()

  await sendCommand(app, "clear")
  await expect(app.getByText("Conversation cleared: the agent starts fresh from here")).toBeVisible({ timeout: 60_000 })
  await expect(app.getByText("BEFORECLEAR", { exact: true })).toBeVisible()
  await expect.poll(async () => notices(await api.messages(workspace.directory, session.id))).toContainEqual({ kind: "conversation-reset", trigger: "clear" })

  await sendPrompt(app, "Reply with exactly this one token: AFTERCLEAR")
  await expect(app.getByText("AFTERCLEAR", { exact: true })).toBeVisible()
  const after = stack.scripted.requests.filter((request) => request.prompt.includes("AFTERCLEAR"))
  expect(after.length).toBeGreaterThan(0)
  expect(after.every((request) => !JSON.stringify(request.body).includes("BEFORECLEAR"))).toBe(true)
})
