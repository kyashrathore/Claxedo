import { chooseOrgSandboxProvider, expect, makeCloudWorkspace, sessionRoute, showHarnesses, storeOwnerKey, test } from "../harness"

test("57 composer: Claude Code on a cloud workspace whose provider cannot keep the key out offers Claude through Pi, and the switch picks the matching model without waking the workspace", async ({ signedCloud, page }) => {
  await storeOwnerKey(signedCloud, "claude-sdk", "sk-ant-api03-owner")
  const workspace = await makeCloudWorkspace(signedCloud, "main")
  await chooseOrgSandboxProvider(signedCloud, "boat", { api_key: "bx-e2e" })
  await signedCloud.signIn(page, signedCloud.owner)
  const starts: string[] = []
  page.on("request", (request) => { if (new URL(request.url()).pathname === `/api/workspace/${workspace.id}/connection`) starts.push(request.method()) })

  await page.goto(`${signedCloud.url}${sessionRoute(workspace.id)}`)
  await page.locator('[data-action="prompt-harness-model"]').filter({ visible: true }).click()
  const picker = page.getByRole("dialog", { name: "Select harness, model and effort" })
  await showHarnesses(picker)
  await picker.getByRole("button", { name: "Claude Code", exact: true }).click()

  await expect(picker.getByText("Claude Code runs inside the workspace, and your organization's cloud provider can't keep your key out of it.", { exact: true })).toBeVisible()
  await expect(picker.getByText(/^Use Claude .+ through Pi — same account\.$/)).toBeVisible()
  await expect(picker.getByText(/secret_brokering_unsupported|harness_needs_brokering/)).toHaveCount(0)

  await picker.getByRole("button", { name: "Switch to Pi", exact: true }).click()
  await expect(picker.getByRole("button", { name: /^Harness/ })).toContainText("Pi")
  await expect(picker.getByRole("button", { name: /^Model/ })).toContainText("Claude Sonnet")
  await expect(page.locator('[data-action="prompt-harness-model"]').filter({ visible: true })).toContainText(/^Claude Sonnet/)
  await expect(page.getByText("This workspace is asleep. Your next message wakes it.", { exact: true })).toBeVisible()
  expect(starts.filter((method) => method === "POST"), "the refusal is answered without starting the workspace").toEqual([])
})
