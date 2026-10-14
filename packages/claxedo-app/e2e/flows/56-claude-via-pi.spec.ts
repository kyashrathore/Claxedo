import { chooseOrgSandboxProvider, expect, storeOwnerKey, test } from "../harness"

test("56 settings: once the organization's cloud provider cannot keep a key out of a workspace, a Claude Code account still works there through the control plane's broker and only a Cursor account says it cannot", async ({ signedCloud, page }, testInfo) => {
  await storeOwnerKey(signedCloud, "claude-sdk", "sk-ant-api03-owner")
  await storeOwnerKey(signedCloud, "cursor-sdk", "key_user_e2e_owner")
  await signedCloud.signIn(page, signedCloud.owner)
  await page.goto(`${signedCloud.url}/settings/models`)
  const claude = page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: "Claude Code", exact: true }) }).last()
  const cursor = page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: "Cursor", exact: true }) }).last()
  const machinesOnly = page.getByText("Works on your machines; your organization's cloud provider can't run it", { exact: true })
  const throughPi = page.getByText("Works on your machines and through Pi in cloud workspaces", { exact: true })
  await expect(claude.getByRole("radio")).toHaveCount(1)
  await expect(cursor.getByRole("radio")).toHaveCount(1)
  await expect(machinesOnly).toHaveCount(0)
  await expect(throughPi).toHaveCount(0)

  await chooseOrgSandboxProvider(signedCloud, "boat", { api_key: "bx-e2e" })
  await page.reload()
  await expect(cursor.getByText("Works on your machines; your organization's cloud provider can't run it", { exact: true })).toBeVisible()
  await expect(claude.getByText(/Works on your machines/)).toHaveCount(0)
  await expect(throughPi).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("models-cloud-note.png") })
})
