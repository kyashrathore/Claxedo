import { expect, type Locator, type Page } from "@playwright/test"
import { UI } from "./ui-names"

export type SendOptions = { scope?: Page | Locator; waitForSend?: boolean }

export async function sendPrompt(page: Page, text: string, options: SendOptions = {}) {
  const scope = options.scope ?? page
  await scope.getByRole("textbox", { name: UI.composer }).click()
  await page.keyboard.type(text)
  await expect(scope.getByText(UI.composer, { exact: true }).filter({ visible: true })).toHaveCount(0)
  const busy = await scope.getByRole("button", { name: UI.stop, exact: true }).isVisible()
  if (!busy && options.waitForSend !== false) await expect(scope.getByRole("button", { name: UI.send, exact: true })).toBeEnabled()
  await page.keyboard.press("Enter")
}
