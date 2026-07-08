import { expect, test } from "@playwright/test"

test.describe("dialog matrix", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/__e2e/dialog-matrix")
    await expect(page.getByTestId("dialog-matrix-harness")).toBeVisible()
    await expect(page.getByTestId("dialog-active")).toHaveText("inactive")
  })

  test("show, push, replace, close, escape, overlay close, and reopen stay stable @happy", async ({ page }) => {
    await page.getByTestId("show-model").click()
    await expect(page.getByRole("dialog", { name: "Model picker" })).toBeVisible()
    await expect(page.getByTestId("dialog-active")).toHaveText("active")

    await page.evaluate(() => window.__claxedoDialogMatrix?.push("directory"))
    await expect(page.getByRole("dialog", { name: "Directory picker" })).toBeVisible()
    await expect(page.getByTestId("dialog-body-model")).toBeVisible()
    await expect(page.locator('[data-component="dialog"]').filter({ hasText: /picker/i })).toHaveCount(2)

    await page.getByTestId("replace-provider").last().click()
    await expect(page.getByRole("dialog", { name: "Provider dialog" })).toBeVisible()
    await expect(page.getByRole("dialog", { name: "Model picker" })).toHaveCount(0)
    await expect(page.getByRole("dialog", { name: "Directory picker" })).toHaveCount(0)

    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog", { name: "Provider dialog" })).toHaveCount(0)
    await expect(page.getByTestId("dialog-active")).toHaveText("inactive")

    await page.getByTestId("show-project").click()
    await expect(page.getByRole("dialog", { name: "Project dialog" })).toBeVisible()
    await page.locator('[data-component="dialog-overlay"]').click({ position: { x: 10, y: 10 } })
    await expect(page.getByRole("dialog", { name: "Project dialog" })).toHaveCount(0)
    await expect(page.getByTestId("dialog-active")).toHaveText("inactive")

    await page.getByTestId("show-release").click()
    await expect(page.getByRole("dialog", { name: "Release notes" })).toBeVisible()
    await page.getByTestId("show-fork").click()
    await expect(page.getByRole("dialog", { name: "Fork dialog" })).toBeVisible()
    await expect(page.getByRole("dialog", { name: "Release notes" })).toHaveCount(0)

    await page.getByTestId("close-dialog").click()
    await expect(page.getByRole("dialog", { name: "Fork dialog" })).toHaveCount(0)
    await expect(page.getByTestId("dialog-active")).toHaveText("inactive")
  })
})
