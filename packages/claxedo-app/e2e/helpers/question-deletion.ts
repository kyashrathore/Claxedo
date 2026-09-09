import { expect, type Page } from "@playwright/test"

export async function deletePendingQuestion(page: Page, input: { backendUrl: string; directory: string; sessionId: string }) {
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
  await page.getByRole("button", { name: "Delete session", exact: true }).click()
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
