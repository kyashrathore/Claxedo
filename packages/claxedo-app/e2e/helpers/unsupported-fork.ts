import { expect, type Page } from "@playwright/test"

export async function expectUnsupportedFork(page: Page, input: { backendUrl: string; directory: string; sessionId: string }) {
  const query = `?directory=${encodeURIComponent(input.directory)}`
  const sessions = async () => {
    const response = await page.request.get(`${input.backendUrl}/session${query}`)
    expect(response.ok()).toBe(true)
    return (await response.json() as Array<{ id: string }>).map((row) => row.id).sort()
  }
  const messages = async () => {
    const response = await page.request.get(`${input.backendUrl}/session/${input.sessionId}/message${query}`)
    expect(response.ok()).toBe(true)
    return await response.json() as Array<{ info: { id: string; role: string } }>
  }
  const before = await messages()
  const user = before.find((message) => message.info.role === "user")
  expect(user, "A real existing message must make fork eligible apart from harness capability").toBeTruthy()
  const ids = await sessions()
  const composer = page.locator('[data-component="prompt-input"]').last()
  await composer.fill("/fork")
  await expect(composer).toContainText("/fork")
  await expect(page.getByRole("listbox", { name: "Commands", exact: true })).toHaveText("No matching commands")
  await expect(page.locator('button[data-slash-id="session.fork"]')).toHaveCount(0)
  await composer.press("Escape")
  await composer.fill("")
  const response = await page.request.post(`${input.backendUrl}/session/${input.sessionId}/fork${query}`, {
    data: { messageId: user!.info.id },
  })
  expect(response.status()).toBe(409)
  expect(await response.json()).toMatchObject({ ok: false, error: { code: "unsupported_operation", operation: "fork", capability: "fork", reason: "capability_disabled" } })
  expect(await sessions()).toEqual(ids)
  expect(await messages()).toEqual(before)
}
