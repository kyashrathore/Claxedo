import { expect, type Page } from "@playwright/test"

/** Confirm the open Delete dialog, optionally dropping the real mutation response. */
export async function confirmSessionDeletion(page: Page, input: { sessionId: string; interruptResponse?: boolean }) {
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
}
