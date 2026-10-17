import { chooseOrgSandboxProvider, draftModelChoices, expect, makeCloudWorkspace, sessionRoute, showHarnesses, storeOwnerKey, test } from "../harness"

test("59 a draft on an asleep cloud workspace lists Claude Code's models and keeps the one picked, without waking the workspace", async ({ signedCloud, page }) => {
  await storeOwnerKey(signedCloud, "claude-sdk", "sk-ant-api03-owner")
  const workspace = await makeCloudWorkspace(signedCloud, "main")
  await chooseOrgSandboxProvider(signedCloud, "boat", { api_key: "bx-e2e" })
  await signedCloud.signIn(page, signedCloud.owner)
  const starts: string[] = []
  page.on("request", (request) => { if (new URL(request.url()).pathname === `/api/workspace/${workspace.id}/connection`) starts.push(request.method()) })

  await page.goto(`${signedCloud.url}${sessionRoute(workspace.id)}`)
  await expect(page.getByText("This workspace is asleep. It wakes when you send a message.", { exact: true })).toBeVisible()
  const trigger = page.locator('[data-action="prompt-harness-model"]').filter({ visible: true })
  await trigger.click()
  const picker = page.getByRole("dialog", { name: "Select harness, model and effort" })
  await showHarnesses(picker)
  await picker.getByRole("button", { name: "Claude Code", exact: true }).click()

  for (const model of ["Opus", "Sonnet", "Haiku"]) await expect(picker.getByRole("button", { name: new RegExp(`^${model} `) })).toBeVisible()
  await expect(picker.getByText("Its models load once it wakes.", { exact: true })).toHaveCount(0)
  await picker.getByRole("button", { name: /^Sonnet / }).click()
  await page.keyboard.press("Escape")
  await expect(trigger).toContainText("Sonnet")

  expect(await draftModelChoices(signedCloud, workspace, "claude")).toEqual({ current: "default", ids: expect.arrayContaining(["default", "opus", "sonnet", "haiku"]) })
  expect(starts.filter((method) => method === "POST"), "the models come without starting the workspace").toEqual([])
})
