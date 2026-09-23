import { expect, type Page } from "@playwright/test"

/** A failed metadata read must not retire a session that still exists. */
export async function expectSessionReadRecovery(page: Page, input: {
  backendUrl: string
  directory: string
  sessionId: string
}) {
  const url = `${input.backendUrl}/session/${input.sessionId}?directory=${encodeURIComponent(input.directory)}`
  const before = await page.request.get(url)
  expect(before.ok()).toBe(true)
  const session = await before.json()
  const target = (url: URL) => url.pathname === `/session/${input.sessionId}`
  await page.route(target, async (route) => {
    if (route.request().method() !== "GET") return route.continue()
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({
      error: { code: "internal_error", message: "Temporary metadata read failure" },
    }) })
  })
  try {
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect.poll(() => page.evaluate((id) => {
      const client = (window as unknown as { __claxedoQueryClient?: {
        getQueryCache(): { getAll(): Array<{ queryKey: unknown[]; state: { status: string; error?: { status?: number } } }> }
      } }).__claxedoQueryClient
      return client?.getQueryCache().getAll().find((query) => query.queryKey.includes("row") && query.queryKey.includes(id))?.state.error?.status
    }, input.sessionId)).toBe(500)
    await expect(page.locator(`[data-session-id="${input.sessionId}"]:visible`).first()).toBeVisible()
    await expect(page.locator('[data-slot="session-turn-assistant-content"]:visible').first()).toBeVisible()
    await expect(page.getByTestId("session-unavailable")).toHaveCount(0)
  } finally {
    await page.unroute(target)
  }
  const recovered = page.waitForResponse((response) => target(new URL(response.url())) &&
    response.request().method() === "GET" && response.status() === 200)
  await page.reload({ waitUntil: "domcontentloaded" })
  await recovered
  const after = await page.request.get(url)
  expect(after.ok()).toBe(true)
  expect(await after.json()).toEqual(session)
  await expect(page.locator(`[data-session-id="${input.sessionId}"]:visible`).first()).toBeVisible()
  await expect(page.getByTestId("session-unavailable")).toHaveCount(0)
}
