import type { Page } from "@playwright/test"
import {
  cloudWorkspaceNames,
  cloudWorkspaces,
  expect,
  holdResponse,
  listedSessions,
  makeCloudWorkspace,
  ownerDevices,
  revokeOwnerMachines,
  sendPrompt,
  sessionRoute,
  startCloudWorkspace,
  storeOwnerKey,
  test,
  UI,
} from "../harness"

function wherePicker(page: Page) {
  return page.locator('[data-context-chip-picker="context-chip-where"]')
}

async function chooseNewCloudWorkspace(page: Page, name: string) {
  const chip = page.getByRole("button", { name: "Where it runs", exact: true })
  await chip.click()
  const picker = wherePicker(page)
  await picker.getByRole("button", { name: "New cloud workspace" }).click()
  await picker.getByRole("textbox", { name: "Cloud workspace name" }).fill(name)
  await picker.getByRole("button", { name: "New cloud workspace" }).click()
  await expect(chip).toHaveText(`${name} · new`)
}

async function choosePi(page: Page) {
  await page.getByRole("button", { name: /^Select harness and model/ }).click()
  const picker = page.getByRole("dialog", { name: "Select harness, model and effort" })
  await picker.getByRole("button", { name: /^Harness/ }).click()
  await page.getByRole("button", { name: "Pi", exact: true }).click()
  await picker.getByRole("button", { name: "GPT-4.1", exact: true }).click()
  await page.keyboard.press("Escape")
}

function lifecycle(page: Page) {
  return page.locator('[data-notice="first-send"], [data-notice="workspace-lifecycle"]')
}

test("52 the Where chip names a cloud workspace by its name, and a new one needs a name", async ({ signedCloud: signed, page }) => {
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
})

test("52 the first send on a new cloud workspace shows it being created, then waking, keeps the message, and sends it once the workspace is up", async ({ signedCloud: signed, page }) => {
  test.setTimeout(150_000)
  await storeOwnerKey(signed, "openai", "cloud-owner-key")
  const workspace = await makeCloudWorkspace(signed, "payments")
  await startCloudWorkspace(signed, workspace)
  await signed.signIn(page, signed.owner)
  await page.goto(`${signed.url}${sessionRoute(workspace.id)}`)
  await choosePi(page)
  await chooseNewCloudWorkspace(page, "checkout")
  const created = await holdResponse(page, /\/api\/workspace\/create$/)
  const started = await holdResponse(page, /\/api\/workspace\/ws_[^/]+\/connection$/, (url) => !url.pathname.includes(workspace.id))

  await sendPrompt(page, "Reply with exactly this one token: FIRSTCLOUDSEND")
  await created.computed
  await expect(lifecycle(page)).toHaveText("Creating checkout…")
  await expect(page.getByText("Reply with exactly this one token: FIRSTCLOUDSEND")).toBeVisible()
  await created.release()
  await started.computed
  await expect(lifecycle(page)).toContainText("Waking checkout")
  await expect(lifecycle(page)).toContainText("Starting the machine, about a minute")
  await started.release()

  await expect(page.getByText("FIRSTCLOUDSEND", { exact: true })).toBeVisible({ timeout: 90_000 })
  await expect(lifecycle(page)).toHaveCount(0)
  await expect(page.getByRole("textbox", { name: UI.composer })).toHaveText("")
  const checkout = (await cloudWorkspaces(signed)).find((row) => row.name === "checkout")
  expect(checkout && (await listedSessions(signed, checkout)).length).toBe(1)
})

test("52 a first send whose cloud workspace is refused keeps the message, shows the server's reason with Retry, and keeps the text in that draft", async ({ signedCloud: signed, page }) => {
  const workspace = await makeCloudWorkspace(signed, "payments")
  for (const name of ["one", "two", "three", "four"]) await makeCloudWorkspace(signed, name)
  await signed.signIn(page, signed.owner)
  await page.goto(`${signed.url}${sessionRoute(workspace.id)}`)
  await chooseNewCloudWorkspace(page, "checkout")

  await sendPrompt(page, "Start in a refused cloud workspace", { waitForSend: false })
  const failure = page.locator('[data-notice="first-send"]')
  await expect(failure).toContainText("Your message was not sent")
  await expect(failure).toContainText("limit")
  await expect(page.getByText("Start in a refused cloud workspace")).toBeVisible()
  await expect(page.getByRole("textbox", { name: UI.composer })).toBeHidden()
  await failure.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(failure).toContainText("Your message was not sent")
  await expect(page.getByText("Start in a refused cloud workspace")).toBeVisible()
  expect(await cloudWorkspaceNames(signed)).not.toContain("checkout")
  await page.reload()
  await expect(page.getByRole("textbox", { name: UI.composer })).toHaveText("Start in a refused cloud workspace")
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
