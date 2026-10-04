import type { Page } from "@playwright/test"
import { cloudWorkspaceNames, expect, makeCloudWorkspace, ownerDevices, revokeOwnerMachines, sessionRoute, test, UI } from "../harness"

function wherePicker(page: Page) {
  return page.locator('[data-context-chip-picker="context-chip-where"]')
}

test("52 the Where chip names a cloud workspace by its name, and a new one needs a name and is created with it on the first send", async ({ signedCloud: signed, page }) => {
  test.setTimeout(120_000)
  const workspace = await makeCloudWorkspace(signed, "payments")
  await signed.signIn(page, signed.owner)
  await page.goto(`${signed.url}${sessionRoute(workspace.id)}`)
  const chip = page.getByRole("button", { name: "Where it runs", exact: true })
  await expect(chip).toHaveText("payments")
  await expect(chip).toHaveAttribute("title", workspace.id)
  await expect(page.getByRole("button", { name: "Cloud environment" })).toHaveCount(0)

  await chip.click()
  const picker = wherePicker(page)
  await expect(picker.getByText("payments", { exact: true })).toBeVisible()
  await expect(picker.getByText(workspace.id, { exact: true })).toBeVisible()
  await expect(picker.getByText("This computer — connect it")).toHaveCount(0)
  await picker.getByRole("button", { name: "New cloud workspace" }).click()
  const create = picker.getByRole("button", { name: "New cloud workspace" })
  await expect(create).toBeDisabled()
  await picker.getByRole("textbox", { name: "Cloud workspace name" }).fill("   ")
  await expect(create).toBeDisabled()
  await picker.getByRole("textbox", { name: "Cloud workspace name" }).fill("checkout")
  await create.click()
  await expect(chip).toHaveText("checkout · new")
  await expect(page.getByRole("button", { name: "Base branch", exact: true })).toBeVisible()

  await page.getByRole("textbox", { name: UI.composer }).click()
  await page.keyboard.type("Start in a new cloud workspace")
  await page.keyboard.press("Enter")
  await expect.poll(() => cloudWorkspaceNames(signed)).toContain("checkout")
})

test("52 on the web with no connected machine, the Where chip offers to connect this computer and opens the add-a-machine steps", async ({ signedCloud: signed, page }) => {
  await revokeOwnerMachines(signed)
  const workspace = await makeCloudWorkspace(signed, "notes")
  await signed.signIn(page, signed.owner)
  await page.goto(`${signed.url}${sessionRoute(workspace.id)}`)
  const chip = page.getByRole("button", { name: "Where it runs", exact: true })
  await expect(chip).toHaveText("notes")
  await chip.click()
  const picker = wherePicker(page)
  await expect(picker.getByText("This computer", { exact: true })).toBeVisible()
  await expect(picker.getByText("Cloud", { exact: true })).toBeVisible()
  await picker.getByText("This computer — connect it").click()
  await expect(page).toHaveURL(/\/settings\/machines$/)
  await expect(page.getByRole("button", { name: "Copy invite command" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Copy connect command" })).toBeVisible()
  expect(await ownerDevices(signed)).toEqual([])
})
