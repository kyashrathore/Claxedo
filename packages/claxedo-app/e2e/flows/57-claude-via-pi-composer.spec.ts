import { chooseOrgSandboxProvider, expect, makeCloudWorkspace, sessionRoute, showHarnesses, storeOwnerKey, test } from "../harness"

test("57 composer: on a cloud provider without its own edge, Claude Code runs through the control plane's broker and only Cursor is unavailable there, answered without waking the workspace", async ({ signedCloud, page }) => {
  await storeOwnerKey(signedCloud, "claude-sdk", "sk-ant-api03-owner")
  await storeOwnerKey(signedCloud, "cursor-sdk", "key_user_e2e_owner")
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

  await expect(picker.getByRole("button", { name: /^Harness/ })).toContainText("Claude Code")
  await expect(picker.getByText(/runs inside the workspace, and your organization's cloud provider can't keep your key out of it\./)).toHaveCount(0)
  await expect(picker.getByText(/secret_brokering_unsupported|harness_needs_brokering/)).toHaveCount(0)

  await showHarnesses(picker)
  await picker.getByRole("button", { name: "Cursor", exact: true }).click()
  await expect(picker.getByText("Cursor runs inside the workspace, and your organization's cloud provider can't keep your key out of it.", { exact: true })).toBeVisible()
  await expect(picker.getByText("It runs on your machines, or pick another harness here.", { exact: true })).toBeVisible()
  await expect(picker.getByRole("button", { name: /^Switch to/ })).toHaveCount(0)
  await expect(page.getByText("This workspace is asleep. Your next message wakes it.", { exact: true })).toBeVisible()
  expect(starts.filter((method) => method === "POST"), "the answers come without starting the workspace").toEqual([])
})
