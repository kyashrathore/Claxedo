import type { Page } from "@playwright/test"
import {
  cloudWorkspaceNames,
  cloudWorkspaces,
  expect,
  listedSessions,
  makeCloudWorkspace,
  ownerDevices,
  revokeOwnerMachines,
  sendPrompt,
  sessionRoute,
  showHarnesses,
  startCloudWorkspace,
  storeOwnerKey,
  test,
  UI,
} from "../harness"

function wherePicker(page: Page) {
  return page.locator('[data-context-chip-picker="context-chip-where"]')
}

function whereChip(page: Page) {
  return page.getByRole("button", { name: "Where it runs", exact: true })
}

async function openNewCloudDialog(page: Page) {
  await whereChip(page).click()
  await wherePicker(page).getByRole("button", { name: "New cloud workspace…" }).click()
  return page.getByRole("dialog", { name: "New cloud workspace" })
}

async function choosePi(page: Page) {
  await page.getByRole("button", { name: /^Select harness and model/ }).click()
  const picker = page.getByRole("dialog", { name: "Select harness, model and effort" })
  await showHarnesses(picker)
  await page.getByRole("button", { name: "Pi", exact: true }).click()
  await picker.getByRole("button", { name: "GPT-4.1", exact: true }).click()
  await page.keyboard.press("Escape")
}

test("52 the Where chip lists cloud workspaces by name with their status in words, and a new one needs a name and starts at once", async ({ signedCloud: signed, page }, testInfo) => {
  const workspace = await makeCloudWorkspace(signed, "payments")
  await signed.signIn(page, signed.owner)
  await page.goto(`${signed.url}${sessionRoute(workspace.id)}`)
  const chip = whereChip(page)
  await expect(chip).toHaveText("payments")

  await chip.click()
  const picker = wherePicker(page)
  const row = picker.locator('[data-slot="list-item"]').filter({ hasText: "payments" })
  await expect(row).toContainText(/Asleep|Running|Starting|Setting up/)
  await expect(picker.getByText(workspace.id)).toHaveCount(0)
  await expect(picker.getByText(/This computer|this machine/i)).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath("where-picker-cloud.png") })
  await picker.getByRole("button", { name: "New cloud workspace…" }).click()

  const dialog = page.getByRole("dialog", { name: "New cloud workspace" })
  await expect(dialog.getByText("It starts right away.", { exact: false })).toBeVisible()
  const create = dialog.getByRole("button", { name: "Create", exact: true })
  await expect(create).toBeDisabled()
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("   ")
  await expect(create).toBeDisabled()
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("checkout")
  await page.screenshot({ path: testInfo.outputPath("new-cloud-workspace-dialog.png") })
  expect(await dialog.getByRole("textbox", { name: "Branch (optional)" }).getAttribute("placeholder")).toBeFalsy()
  await create.click()
  await expect(dialog).toHaveCount(0)
  await expect(chip).toHaveText("checkout")
  await expect(page.locator('[data-notice="workspace-lifecycle"]')).toContainText("Waking checkout")
  expect(await cloudWorkspaceNames(signed)).toContain("checkout")
  await expect(chip).toHaveText("checkout")
})

test("52 a first send to a cloud workspace made from the Where chip lands in it", async ({ signedCloud: signed, page }) => {
  test.setTimeout(150_000)
  await storeOwnerKey(signed, "openai", "cloud-owner-key")
  const workspace = await makeCloudWorkspace(signed, "payments")
  await startCloudWorkspace(signed, workspace)
  await signed.signIn(page, signed.owner)
  await page.goto(`${signed.url}${sessionRoute(workspace.id)}`)
  await choosePi(page)
  const dialog = await openNewCloudDialog(page)
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("checkout")
  await dialog.getByRole("button", { name: "Create", exact: true }).click()
  await expect(whereChip(page)).toHaveText("checkout")

  await sendPrompt(page, "Reply with exactly this one token: FIRSTCLOUDSEND")
  await expect(page.getByText("FIRSTCLOUDSEND", { exact: true })).toBeVisible({ timeout: 120_000 })
  await expect(page.getByRole("textbox", { name: UI.composer })).toHaveText("")
  const checkout = (await cloudWorkspaces(signed)).find((row) => row.name === "checkout")
  expect(checkout && (await listedSessions(signed, checkout)).length).toBe(1)
})

test("52 a refused cloud workspace says why in its dialog, and the draft keeps its text", async ({ signedCloud: signed, page }) => {
  const workspace = await makeCloudWorkspace(signed, "payments")
  for (const name of ["one", "two", "three", "four"]) await makeCloudWorkspace(signed, name)
  await signed.signIn(page, signed.owner)
  await page.goto(`${signed.url}${sessionRoute(workspace.id)}`)
  await page.getByRole("textbox", { name: UI.composer }).click()
  await page.keyboard.type("Keep this draft")
  const dialog = await openNewCloudDialog(page)
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("checkout")
  await dialog.getByRole("button", { name: "Create", exact: true }).click()
  await expect(dialog.getByRole("alert")).toContainText("limit")
  expect(await cloudWorkspaceNames(signed)).not.toContain("checkout")
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(whereChip(page)).toHaveText("payments")
  await expect(page.getByRole("textbox", { name: UI.composer })).toHaveText("Keep this draft")
})

test("52 a machine folder is listed by its folder name, with the machine's own name and its state beside it", async ({ signedCloud: signed, page }, testInfo) => {
  const folder = await signed.makeWorkspace("notes-folder", "notes")
  const [device] = await ownerDevices(signed)
  await signed.signIn(page, signed.owner)
  await page.goto(`${signed.url}${sessionRoute(folder.id)}`)
  const chip = whereChip(page)
  await expect(chip).toHaveText("notes-folder")
  await chip.click()
  const picker = wherePicker(page)
  const row = picker.locator('[data-slot="list-item"]').filter({ hasText: "notes-folder" })
  await expect(row).toContainText(/Signed fixture machine · (Online|Offline)/)
  await expect(picker.getByRole("button", { name: "Connect a machine…" })).toHaveCount(0)
  await expect(picker.getByRole("button", { name: /^New worktree on / })).toHaveCount(0)
  await expect(picker.getByText(/This computer|this machine/i)).toHaveCount(0)
  expect(device).toBeTruthy()
  await page.screenshot({ path: testInfo.outputPath("where-picker-machine.png") })
})

test("52 on the web with no connected machine, the Where chip offers Connect a machine…, which opens the instructions", async ({ signedCloud: signed, page }, testInfo) => {
  await revokeOwnerMachines(signed)
  const workspace = await makeCloudWorkspace(signed, "notes")
  await signed.signIn(page, signed.owner)
  await page.goto(`${signed.url}${sessionRoute(workspace.id)}`)
  const chip = whereChip(page)
  await expect(chip).toHaveText("notes")
  await chip.click()
  const picker = wherePicker(page)
  await expect(picker.getByText(/This computer/)).toHaveCount(0)
  await expect(picker.getByRole("button", { name: "New cloud workspace…" })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("where-picker-no-machine.png") })
  await picker.getByRole("button", { name: "Connect a machine…" }).click()
  const drawer = page.getByRole("dialog", { name: "Connect a machine" })
  await expect(drawer.getByRole("button", { name: "Copy invite command" })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`${sessionRoute(workspace.id)}$`))
  await drawer.getByRole("button", { name: "Done" }).click()
  expect(await ownerDevices(signed)).toEqual([])
})
