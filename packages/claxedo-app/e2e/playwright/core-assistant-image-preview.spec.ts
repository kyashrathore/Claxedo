/** Image interaction regression. Shared Tier M streaming runtime; see e2e/INVARIANTS.md. */
import { test, expect } from "@playwright/test"
import { readFile } from "node:fs/promises"
import { installMockRuntime, type MockMessageRow } from "../helpers/mock-runtime"
import { ensureComposerModelSelected, expectAssistantReplyVisible, SELECTORS } from "../helpers/turn-oracle"

const dir = "/tmp/e2e-assistant-image-preview"
const sessionID = "ses_assistant_image_preview"

test("assistant image previews follow streamed source changes and linked thumbnails open by keyboard @core", async ({ page }, testInfo) => {
  const mock = await installMockRuntime(page, {
    dir, sessionId: sessionID, projectId: "proj_mock_runtime", holdTurn: true,
    harnessModels: { opencode: [{ id: "gpt-5", name: "GPT-5" }] },
    existingSession: { messages: [] },
  })
  await page.addInitScript(d => {
    localStorage.clear()
    ;(window as typeof window & { __CLAXEDO__?: unknown }).__CLAXEDO__ = { serverUrl: location.origin, activeDirectory: d }
    localStorage.setItem("claxedo.global.dat:server", JSON.stringify({ list: [], projects: { local: [{ worktree: d, expanded: true }] }, lastProject: {}, workspaceServer: {}, closedProjects: {} }))
  }, dir)
  await page.goto(`/s/${sessionID}`, { waitUntil: "domcontentloaded" })
  await ensureComposerModelSelected(page)
  await page.getByRole("textbox", { name: /Ask anything/i }).filter({ visible: true }).last().fill("Show an image")
  await page.locator(`${SELECTORS.submitControl}:visible`).last().click()
  let assistant: Record<string, unknown> = {}
  await expect.poll(async () => {
    const body = await page.evaluate(async id => (await fetch(`/session/${id}/message`)).json(), sessionID)
    assistant = body.messages?.find((row: MockMessageRow) => row.info.id === mock.requests.promptBodies[0]?.assistantID)?.info ?? {}
    return assistant.id
  }).toBeTruthy()
  const first = `data:image/png;base64,${(await readFile(new URL("../../public/web-app-manifest-512x512.png", import.meta.url))).toString("base64")}`
  const second = `data:image/png;base64,${(await readFile(new URL("../../public/web-app-manifest-192x192.png", import.meta.url))).toString("base64")}`
  const part = { id: "assistant-image", sessionID, messageID: assistant.id, type: "text", time: { start: Date.now() } }
  const emit = (text: string) => mock.emit({ type: "message.part.updated", properties: { part: { ...part, text } } } as never, dir)
  const body = page.locator('[data-timeline-part-id="assistant-image"]')
  const tile = body.locator('[data-component="markdown-image-tile"]')
  const preview = page.locator('[data-slot="image-preview-image"]')
  emit(`![first result](${first})`)
  await expect(tile.locator("img")).toHaveAttribute("src", first)
  emit(`![second result](${second})`)
  await expect(tile.locator("img")).toHaveAttribute("src", second)
  await tile.click()
  await expect(preview).toBeVisible()
  await expect(preview).toHaveAttribute("src", second)
  await expect.poll(() => preview.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(192)
  await page.screenshot({ path: testInfo.outputPath("streamed-assistant-image-preview.png") })
  await page.keyboard.press("Escape")
  await expect(preview).toHaveCount(0)
  emit(`[![linked result](${second})](https://example.com/original)`)
  await expect(tile.locator("img")).toHaveAttribute("alt", "linked result")
  const before = page.url()
  await tile.focus()
  await page.keyboard.press("Enter")
  await expect(preview).toBeVisible()
  await expect(preview).toHaveAttribute("src", second)
  expect(page.url()).toBe(before)
  await page.screenshot({ path: testInfo.outputPath("linked-assistant-image-keyboard-preview.png") })
  await page.keyboard.press("Escape")
  await expect(preview).toHaveCount(0)
  emit(`[![linked result](${second})](https://example.com/original)\n\nQA_IMAGE_PREVIEW_DONE`)
  mock.emit({ type: "message.updated", properties: { info: { ...assistant, time: { ...(assistant.time as Record<string, unknown>), completed: Date.now() } } } } as never, dir)
  mock.emit({ type: "session.idle", properties: { sessionID } }, dir)
  await expectAssistantReplyVisible(page, "QA_IMAGE_PREVIEW_DONE", { spec: "core-assistant-image-preview", scenario: "completed-image-turn" })
  await tile.click()
  await expect(preview).toBeVisible()
  await expect(preview).toHaveAttribute("src", second)
  await page.keyboard.press("Escape")
  await expect(preview).toHaveCount(0)
  expect(mock.requests.unhandled).toEqual([])
})
