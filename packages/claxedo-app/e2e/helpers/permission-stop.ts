import { expect, type Page } from "@playwright/test"

export async function stopPendingPermission(page: Page, input: { backendUrl: string; directory: string; sessionId: string }) {
  const query = `?directory=${encodeURIComponent(input.directory)}`
  const read = async () => {
    const response = await page.request.get(`${input.backendUrl}/permission${query}`)
    expect(response.ok()).toBe(true)
    return (await response.json() as Array<{ id: string; sessionID: string }>).filter((row) => row.sessionID === input.sessionId)
  }
  const pending = await read()
  expect(pending).toHaveLength(1)
  const stop = page.getByRole("button", { name: "Stop", exact: true })
  await expect(stop).toBeVisible({ timeout: 10_000 })
  await stop.click()
  await expect.poll(read).toEqual([])
  await expect(page.locator('[data-component="dock-prompt"][data-kind="permission"]').filter({ visible: true })).toHaveCount(0)
  const late = await page.request.post(`${input.backendUrl}/session/${input.sessionId}/permissions/${pending[0]!.id}${query}`, {
    data: { response: "always" },
  })
  expect(late.status()).toBe(404)
  await page.reload({ waitUntil: "domcontentloaded" })
  expect(await read()).toEqual([])
  await expect(page.locator('[data-component="dock-prompt"][data-kind="permission"]').filter({ visible: true })).toHaveCount(0)
}
