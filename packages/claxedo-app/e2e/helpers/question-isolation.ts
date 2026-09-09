import { expect, test, type Page } from "@playwright/test"
import { expectAssistantReplyVisible } from "./turn-oracle"

/** Keep two native requests pending while exercising workspace and session admission. */
export async function expectConcurrentQuestionIsolation(page: Page, input: {
  backendUrl: string
  presentation: "navigation" | "windows"
  startQuestion(page: Page, index: number): Promise<{ directory: string; answerMarker: string; dismissMarker: string }>
}) {
  const otherPage = input.presentation === "windows" ? await page.context().newPage() : page
  const dock = (target: Page) => target.locator('[data-component="dock-prompt"][data-kind="question"]').filter({ visible: true })
  const pending = async (directory: string) => {
    const response = await page.request.get(`${input.backendUrl}/question?directory=${encodeURIComponent(directory)}`)
    expect(response.ok()).toBe(true)
    return await response.json() as Array<{ id: string; sessionID: string }>
  }
  try {
    const first = await input.startQuestion(page, 0)
    await expect(dock(page)).toBeVisible({ timeout: 60_000 })
    const firstUrl = page.url()
    let second: Awaited<ReturnType<typeof input.startQuestion>>
    try {
      second = await input.startQuestion(otherPage, 1)
    } catch (error) {
      if (input.presentation !== "windows") throw error
      // Diagnose stalled second-window startup without allowing it to pass.
      await page.goto("about:blank")
      await expect(otherPage.locator("[data-claxedo]")).toBeVisible({ timeout: 15_000 })
      await test.info().attach("second-window-startup.txt", {
        body: "Second app window became ready after the first window navigated away and released its event connections.",
        contentType: "text/plain",
      })
      throw error
    }
    await expect(dock(otherPage)).toBeVisible({ timeout: 60_000 })
    const secondUrl = otherPage.url()
    const firstPending = await pending(first.directory)
    const secondPending = await pending(second.directory)
    expect(firstPending).toHaveLength(1)
    expect(secondPending).toHaveLength(1)
    const owner = firstPending[0]!
    const sibling = secondPending[0]!
    expect(owner.id).not.toBe(sibling.id)
    expect(owner.sessionID).not.toBe(sibling.sessionID)
    for (const action of ["reply", "reject"] as const) {
      const data = action === "reply" ? { answers: [["Production"]] } : {}
      const wrongSession = await page.request.post(
        `${input.backendUrl}/question/${owner.id}/${action}?directory=${encodeURIComponent(first.directory)}&sessionId=${sibling.sessionID}`,
        { data },
      )
      expect(wrongSession.status()).toBe(409)
      expect(await wrongSession.json()).toMatchObject({ error: { code: "interaction_session_mismatch" } })
      const wrongWorkspace = await page.request.post(
        `${input.backendUrl}/question/${owner.id}/${action}?directory=${encodeURIComponent(second.directory)}`,
        { data },
      )
      expect(wrongWorkspace.status()).toBe(404)
      expect(await pending(first.directory)).toEqual(firstPending)
      expect(await pending(second.directory)).toEqual(secondPending)
    }
    await otherPage.reload({ waitUntil: "domcontentloaded" })
    await expect(dock(otherPage)).toBeVisible({ timeout: 30_000 })
    await page.goto(firstUrl, { waitUntil: "domcontentloaded" })
    await expect(dock(page)).toBeVisible({ timeout: 30_000 })
    await dock(page).locator('[data-slot="question-option"]', { hasText: "Staging" }).click()
    const replyUrl = (url: URL) => url.pathname === `/question/${owner.id}/reply`
    await page.route(replyUrl, (route) => route.fulfill({
      status: 500, contentType: "application/json",
      body: JSON.stringify({ error: { code: "internal_error", message: "Temporary question reply failure" } }),
    }))
    try {
      const rejected = page.waitForResponse((response) => replyUrl(new URL(response.url())) && response.status() === 500)
      await dock(page).getByRole("button", { name: "Submit", exact: true }).click()
      await rejected
      await expect(page.getByText("Request failed", { exact: true })).toBeVisible()
      await expect(page.getByText("Temporary question reply failure", { exact: true })).toBeVisible()
      expect(await pending(first.directory)).toEqual(firstPending)
      expect(await pending(second.directory)).toEqual(secondPending)
      await expect(dock(page)).toBeVisible()
      await expect(dock(page).getByRole("button", { name: "Submit", exact: true })).toBeEnabled()
      await expect(page.locator('[data-slot="session-turn-assistant-content"]').filter({ hasText: first.answerMarker })).toHaveCount(0)
    } finally {
      await page.unroute(replyUrl)
    }
    await dock(page).getByRole("button", { name: "Submit", exact: true }).click()
    await expectAssistantReplyVisible(page, first.answerMarker)
    await expect.poll(() => pending(first.directory)).toEqual([])
    expect(await pending(second.directory)).toEqual(secondPending)
    if (input.presentation === "navigation") await otherPage.goto(secondUrl, { waitUntil: "domcontentloaded" })
    await expect(dock(otherPage)).toBeVisible({ timeout: 30_000 })
    await dock(otherPage).getByRole("button", { name: "Dismiss", exact: true }).click()
    await expectAssistantReplyVisible(otherPage, second.dismissMarker)
    await expect.poll(() => pending(second.directory)).toEqual([])
    for (const [target, url, marker] of [[page, firstUrl, first.answerMarker], [otherPage, secondUrl, second.dismissMarker]] as const) {
      await target.goto(url, { waitUntil: "domcontentloaded" })
      await expectAssistantReplyVisible(target, marker)
      await expect(dock(target)).toHaveCount(0)
    }
  } finally {
    if (input.presentation === "windows") await otherPage.close()
  }
}
