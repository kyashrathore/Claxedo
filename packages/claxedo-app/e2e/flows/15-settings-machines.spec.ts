import type { Page } from "@playwright/test"
import { expect, test } from "../harness"

async function machines(app: Page, url: string) {
  await app.goto(`${url}/settings/machines`)
  await expect(app.getByRole("heading", { level: 1, name: "Machines" })).toBeVisible()
  await expect(app.getByRole("group", { name: "Remote access" })).toHaveCount(0)
  return app.getByRole("group", { name: "Your machines" })
}

async function connectInstructions(app: Page) {
  await app.getByRole("button", { name: "Connect a machine…" }).click()
  const drawer = app.getByRole("dialog", { name: "Connect a machine" })
  await expect(drawer.getByText("Another machine you own", { exact: true })).toBeVisible()
  await expect(drawer.getByRole("button", { name: "Copy invite command" })).toBeVisible()
  await drawer.getByRole("button", { name: "Done" }).click()
  await expect(drawer).toHaveCount(0)
}

test("15 Machines lists the machine the app runs on with its state, and Connect a machine opens the instructions", async ({ stack, app }) => {
  const yours = await machines(app, stack.url)
  await expect(yours.getByText(/^Online/)).toHaveCount(1)
  await expect(yours.getByText("This computer", { exact: true })).toHaveCount(0)
  await expect(app.getByText("No machine is connected yet.", { exact: true })).toHaveCount(0)
  await connectInstructions(app)
})

test("15 Machines on the web with no machine says so in one line and offers Connect a machine", async ({ signed, page }) => {
  await page.goto(`${signed.url}/`)
  await signed.signIn(page, signed.owner)
  await expect(page).not.toHaveURL(/\/login$/)
  const yours = await machines(page, signed.url)
  await expect(yours.getByText("No machine is connected yet.", { exact: true })).toBeVisible()
  await expect(page.getByText("Not available yet", { exact: true })).toHaveCount(0)
  await connectInstructions(page)
})
