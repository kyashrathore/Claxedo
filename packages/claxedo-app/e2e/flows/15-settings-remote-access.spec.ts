import type { Page } from "@playwright/test"
import { expect, test } from "../harness"

async function remoteAccess(app: Page, url: string) {
  await app.goto(`${url}/settings/machines`)
  await expect(app.getByRole("heading", { level: 1, name: "Machines" })).toBeVisible()
  return app.getByRole("group", { name: "Remote access" })
}

test("15 Machines asks a signed-out person to sign in for remote access", async ({ stack, app }) => {
  const group = await remoteAccess(app, stack.url)
  await expect(group.getByText("Sign-in required", { exact: true })).toBeVisible()
  await expect(group.getByText("Not available yet", { exact: true })).toHaveCount(0)
  await expect(group.getByRole("button", { name: "Enable remote access" })).toBeDisabled()
})

test("15 Machines tells a signed-in person remote access is not available yet instead of asking them to sign in", async ({ signed, page }) => {
  await page.goto(`${signed.url}/`)
  await signed.signIn(page, signed.owner)
  await expect(page).not.toHaveURL(/\/login$/)
  const group = await remoteAccess(page, signed.url)
  await expect(group.getByText("Not available yet", { exact: true })).toBeVisible()
  await expect(group.getByText("Sign-in required", { exact: true })).toHaveCount(0)
  await expect(group.getByRole("button", { name: "Enable remote access" })).toBeDisabled()
})
