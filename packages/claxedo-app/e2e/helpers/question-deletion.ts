import { expect, type Page } from "@playwright/test"

export async function deletePendingQuestion(page: Page, input: { backendUrl: string; directory: string; sessionId: string; interruptResponse?: boolean }) {
  const query = `?directory=${encodeURIComponent(input.directory)}`
  const read = async () => {
    const response = await page.request.get(`${input.backendUrl}/question${query}`)
    expect(response.ok()).toBe(true)
    return (await response.json() as Array<{ id: string; sessionID: string }>).filter((row) => row.sessionID === input.sessionId)
  }
  const pending = await read()
  expect(pending).toHaveLength(1)
  await page.reload({ waitUntil: "domcontentloaded" })
  const dock = page.locator('[data-component="dock-prompt"][data-kind="question"]').filter({ visible: true })
  await expect(dock).toBeVisible()
  expect(await read()).toEqual(pending)
  await page.getByRole("button", { name: "More options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click()
  if (input.interruptResponse) {
    const target = (url: URL) => url.pathname === `/session/${input.sessionId}`
    let completed!: () => void
    let failed!: (error: unknown) => void
    const deletion = new Promise<void>((resolve, reject) => { completed = resolve; failed = reject })
    await page.route(target, async (route) => {
      if (route.request().method() !== "DELETE") return route.continue()
      try {
        // Execute the real mutation, then lose only its response. The UI must
        // recover from server state without its successful Delete callback.
        const response = await route.fetch()
        expect(response.ok(), await response.text()).toBe(true)
        await route.abort("failed")
        completed()
      } catch (error) { failed(error) }
    })
    try {
      await page.getByRole("button", { name: "Delete session", exact: true }).click()
      await deletion
      await page.reload({ waitUntil: "domcontentloaded" })
    } finally {
      await page.unroute(target)
    }
  } else {
    const deletion = page.waitForResponse((response) => response.request().method() === "DELETE" &&
      new URL(response.url()).pathname === `/session/${input.sessionId}`)
    await page.getByRole("button", { name: "Delete session", exact: true }).click()
    const deleted = await deletion
    expect(deleted.ok(), await deleted.text()).toBe(true)
  }
  await expect(page.locator(`[data-session-id="${input.sessionId}"]`)).toHaveCount(0)
  await expect.poll(read).toEqual([])
  await expect(dock).toHaveCount(0)
  const late = await page.request.post(`${input.backendUrl}/question/${pending[0]!.id}/reply${query}`, {
    data: { answers: [["Staging"]] },
  })
  expect(late.status()).toBe(404)
  await page.reload({ waitUntil: "domcontentloaded" })
  expect(await read()).toEqual([])
  expect((await page.request.get(`${input.backendUrl}/session/${input.sessionId}${query}`)).status()).toBe(404)
  await expect(dock).toHaveCount(0)
}
