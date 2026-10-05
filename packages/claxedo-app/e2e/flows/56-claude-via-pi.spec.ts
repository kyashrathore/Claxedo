import { chooseOrgSandboxProvider, expect, storeOwnerKey, test } from "../harness"

test("56 settings: a Claude Code account says it works through Pi once the organization's cloud provider cannot keep its key out of a workspace", async ({ signedCloud, page }, testInfo) => {
  await storeOwnerKey(signedCloud, "claude-sdk", "sk-ant-api03-owner")
  await signedCloud.signIn(page, signedCloud.owner)
  await page.goto(`${signedCloud.url}/settings/models`)
  const claude = page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: "Claude Code", exact: true }) }).last()
  const note = claude.getByText("Works on your machines and through Pi in cloud workspaces", { exact: true })
  await expect(claude.getByRole("radio")).toHaveCount(1)
  await expect(note).toHaveCount(0)

  await chooseOrgSandboxProvider(signedCloud, "boat", { api_key: "bx-e2e" })
  await page.reload()
  await expect(note).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("models-cloud-note.png") })
})
