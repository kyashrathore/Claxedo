import type { Locator } from "@playwright/test"

export async function toggleSwitch(input: Locator): Promise<void> {
  await input.locator('xpath=ancestor::*[@data-component="switch"][1]').locator('[data-slot="switch-control"]').click()
}
