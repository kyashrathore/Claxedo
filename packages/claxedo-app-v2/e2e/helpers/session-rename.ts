import { expect, type Page } from "@playwright/test"

export async function expectSessionRenamePersistence(page: Page, input: {
  backendUrl: string
  directory: string
  sessionId: string
  restartServer: () => Promise<void | Page>
}) {
  const query = `?directory=${encodeURIComponent(input.directory)}`
  const read = async (suffix = "") => {
    const response = await page.request.get(`${input.backendUrl}/session/${input.sessionId}${suffix}${query}`)
    expect(response.ok(), await response.text()).toBe(true)
    return await response.json()
  }
  const config = await read("/config") as { harness: { id: string; access: string } }
  // Visible streamed text can precede the authoritative turn completion.
  await expect.poll(async () => {
    const history = await read("/message") as Array<{ info: { role: string; time: { completed?: number } } }>
    return history.filter((message) => message.info.role === "assistant").at(-1)?.info.time.completed
  }, { timeout: 90_000 }).toBeGreaterThan(0)
  const original = await read() as { title: string | null }
  const messages = await read("/message")
  const created = await page.request.post(`${input.backendUrl}/session${query}&nativeHarness=${config.harness.id}`, {
    data: { harness: config.harness, title: "Rename neighbor" },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const neighbor = await created.json() as { id: string }
  let header = page.locator('h1[data-slot="session-title-child"]')
  const editor = page.locator('input[data-slot="session-title-child"]')
  await expect(header).toBeVisible()
  const originalLabel = await header.innerText()
  await header.dblclick()
  await expect(editor).toHaveValue(originalLabel)
  await editor.fill("Cancelled rename")
  await editor.press("Escape")
  expect((await read() as { title: string }).title).toBe(original.title)
  await header.dblclick()
  await editor.fill("   ")
  await editor.press("Enter")
  await expect(header).toHaveText(originalLabel)
  expect((await read() as { title: string }).title).toBe(original.title)
  await header.dblclick()
  const title = "Renamed café 日本語 🚀"
  await editor.fill(`  ${title}  `)
  await editor.press("Enter")
  await expect(header).toHaveText(title)
  await expect.poll(async () => (await read() as { title: string }).title).toBe(title)
  const sessionUrl = page.url()
  page = await input.restartServer() ?? page
  header = page.locator('h1[data-slot="session-title-child"]')
  await page.reload()
  await expect(page).toHaveURL(sessionUrl)
  await expect(header).toHaveText(title)
  await expect(page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${input.sessionId}"]`)).toContainText(title)
  expect(await read()).toMatchObject({ id: input.sessionId, title })
  expect(await read("/message")).toEqual(messages)
  expect(await read("/config")).toMatchObject({ harness: config.harness })
  const preserved = await page.request.get(`${input.backendUrl}/session/${neighbor.id}${query}`)
  expect(preserved.ok()).toBe(true)
  expect(await preserved.json()).toMatchObject({ id: neighbor.id, title: "Rename neighbor" })
}
