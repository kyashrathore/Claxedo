import { expect, type Locator, type Page } from "@playwright/test"
import { UI } from "./ui-names"

export async function sendPrompt(page: Page, text: string, scope: Page | Locator = page) {
  await scope.getByRole("textbox", { name: UI.composer }).click()
  await page.keyboard.type(text)
  await expect(scope.getByRole("button", { name: UI.send, exact: true })).toBeEnabled()
  await page.keyboard.press("Enter")
}
