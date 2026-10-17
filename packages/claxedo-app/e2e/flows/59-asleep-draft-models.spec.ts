import { chooseOrgSandboxProvider, draftModelChoices, expect, makeCloudWorkspace, sessionRoute, showHarnesses, storeOwnerKey, test, type SignedStack } from "../harness"
import { harnessSection } from "./15-settings.navigation"

async function bootsServed(signed: SignedStack) {
  return (await signed.hosted.telemetryEvents()).filter((entry) => entry.event === "workspace_ready" || entry.event === "workspace_woken").length
}

test("59 a draft on an asleep cloud workspace and Settings → Models list Claude Code's models, the draft keeps the one picked, and neither wakes the workspace", async ({ signedCloud, page }) => {
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

  const forwarded = signedCloud.controlPlaneRequests().length
  const boots = await bootsServed(signedCloud)
  await page.goto(`${signedCloud.url}/settings/models`)
  const claude = harnessSection(page, "Claude Code")
  await claude.getByRole("tab", { name: "Models" }).click()
  for (const model of ["Opus", "Sonnet", "Haiku"]) await expect(claude.getByRole("switch", { name: model, exact: true })).toBeVisible()
  await expect(claude.getByText(/couldn't list|can't list/)).toHaveCount(0)
  expect(starts.filter((method) => method === "POST"), "Settings → Models starts no workspace").toEqual([])
  expect(signedCloud.controlPlaneRequests().slice(forwarded).filter((request) => request === `POST /api/workspace/${workspace.id}/connection`)).toEqual([])
  expect(await bootsServed(signedCloud), "the server started no workspace").toBe(boots)
})
