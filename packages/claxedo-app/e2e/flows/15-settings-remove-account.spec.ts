import { HARNESS_TABLE } from "@claxedo/agent-runtime-contract"
import { expect, test } from "../harness"
import { saveOrgAccount } from "../harness/saved-org-account"

test("15 settings: the local operator removes a saved organization account, cancellation preserves it, and the machine login stays protected", async ({ stack, app, isMobile }) => {
  await stack.daemon.makeWorkspace("remove-account", "Remove account")
  const id = await saveOrgAccount(stack)
  const read = async () => {
    const response = await fetch(`${stack.url}/api/claxedo/credentials/account-sources`)
    expect(response.status).toBe(200)
    return await response.json() as { can_remove_org_accounts: boolean; org: Array<{ id: string }> }
  }
  expect(await read()).toMatchObject({ can_remove_org_accounts: true, org: [expect.objectContaining({ id })] })
  await app.goto(`${stack.url}/settings/models`)
  const accounts = app.getByRole("radiogroup", { name: "Claude Code", exact: true })
  const saved = accounts.locator('[data-slot="account-row"]').filter({ hasText: "Saved Claude account" })
  const machine = accounts.locator('[data-slot="account-row"][data-account="machine"]')
  await expect(saved).toBeVisible()
  await machine.getByText("This computer's login", { exact: true }).click()
  await expect(machine.getByRole("radio")).toBeChecked()
  await expect(machine.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0)
  const remove = saved.getByRole("button", { name: "Remove", exact: true })
  await expect(remove).toBeVisible()
  if (isMobile) {
    const box = await remove.boundingBox()
    expect(box?.height).toBeGreaterThanOrEqual(44)
    expect(box?.width).toBeGreaterThanOrEqual(44)
  }
  await remove.click()
  await expect(saved.getByRole("button", { name: "Cancel", exact: true })).toBeVisible()
  expect(await app.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await saved.getByRole("button", { name: "Cancel", exact: true }).click()
  expect((await read()).org.some((account) => account.id === id)).toBe(true)
  await remove.click()
  await remove.click()
  await expect(saved).toHaveCount(0)
  await expect(accounts.locator('[data-account="org"]')).toHaveCount(0)
  expect((await read()).org.some((account) => account.id === id)).toBe(false)
  await expect(machine.getByRole("radio")).toBeChecked()
  await expect(machine.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0)
  await app.reload()
  await expect(machine.getByRole("radio")).toBeChecked()
  await expect(saved).toHaveCount(0)
  await expect(accounts.locator('[data-account="org"]')).toHaveCount(0)
})

test("15 settings: an unavailable selected organization account explains the failure and disappears after choosing the machine login", async ({ stack, app }) => {
  await stack.daemon.makeWorkspace("missing-org", "Missing organization")
  const response = await fetch(`${stack.url}/api/claxedo/credentials/account-sources`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider_ids: HARNESS_TABLE.cursor.providerIds, source: "org" }),
  })
  expect(response.status).toBe(200)
  await app.goto(`${stack.url}/settings/models`)
  const accounts = app.getByRole("radiogroup", { name: "Cursor", exact: true })
  const missing = accounts.locator('[data-account="org"]')
  await expect(missing.getByRole("radio")).toBeChecked()
  await expect(missing.getByRole("radio")).toBeDisabled()
  await expect(missing.getByText("Cursor can't run for you: your organization has no account for this provider. Choose your own account to use it.", { exact: true })).toBeVisible()
  await accounts.getByText("This computer's login", { exact: true }).click()
  await expect(missing).toHaveCount(0)
  const read = await fetch(`${stack.url}/api/claxedo/credentials/account-sources`)
  expect(read.status).toBe(200)
  expect((await read.json()).sources).toMatchObject(Object.fromEntries(HARNESS_TABLE.cursor.providerIds.map((id) => [id, "own"])))
  await app.reload()
  await expect(missing).toHaveCount(0)
  await expect(accounts.getByRole("radio")).toBeChecked()
})
