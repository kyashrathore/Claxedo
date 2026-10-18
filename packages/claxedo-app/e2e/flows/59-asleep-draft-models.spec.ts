import { chooseOrgSandboxProvider, draftModelChoices, expect, makeCloudWorkspace, sessionRoute, showHarnesses, storeOwnerKey, test, type SignedStack } from "../harness"
import { harnessSection } from "./15-settings.navigation"

async function bootsServed(signed: SignedStack) {
  return (await signed.hosted.telemetryEvents()).filter((entry) => entry.event === "workspace_ready" || entry.event === "workspace_woken").length
}

test("59 a draft on an asleep cloud workspace and Settings → Models list Claude Code's models, the draft keeps the one picked, Settings reads no workspace, and neither wakes the workspace", async ({ signedCloud, page }) => {
  await storeOwnerKey(signedCloud, "claude-sdk", "sk-ant-api03-owner")
  const workspace = await makeCloudWorkspace(signedCloud, "main")
  await chooseOrgSandboxProvider(signedCloud, "boat", { api_key: "bx-e2e" })
  await signedCloud.signIn(page, signedCloud.owner)
  const starts: string[] = []
  const modelReads: string[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname === `/api/workspace/${workspace.id}/connection`) starts.push(request.method())
    if (url.pathname === "/api/claxedo/agent-config/harness/options" || url.pathname === "/api/claxedo/credentials/harness-models") modelReads.push(`${url.pathname}${url.search}`)
  })

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
  const draftReads = modelReads.length
  await page.goto(`${signedCloud.url}/settings/models`)
  const claude = harnessSection(page, "Claude Code")
  await claude.getByRole("tab", { name: "Models" }).click()
  for (const model of ["Opus", "Sonnet", "Haiku"]) await expect(claude.getByRole("switch", { name: model, exact: true })).toBeVisible()
  await expect(claude.getByText(/couldn't list|can't list/)).toHaveCount(0)
  expect(modelReads.slice(draftReads), "Settings reads Claude Code's models with no workspace").toEqual(["/api/claxedo/credentials/harness-models?nativeHarness=claude"])
  expect(starts.filter((method) => method === "POST"), "Settings → Models starts no workspace").toEqual([])
  expect(signedCloud.controlPlaneRequests().slice(forwarded).filter((request) => request === `POST /api/workspace/${workspace.id}/connection`)).toEqual([])
  expect(await bootsServed(signedCloud), "the server started no workspace").toBe(boots)
})

type OpenCodeCatalog = { readonly all: readonly { readonly id: string; readonly models: Readonly<Record<string, { readonly name: string }>> }[]; readonly default: Readonly<Record<string, string>> }

test("59 an OpenCode draft on an asleep cloud workspace and Settings → Models list OpenCode's models from the control plane, and neither wakes the workspace", async ({ signedCloud, page }) => {
  await storeOwnerKey(signedCloud, "openai", "sk-proj-owner")
  const workspace = await makeCloudWorkspace(signedCloud, "main")
  await chooseOrgSandboxProvider(signedCloud, "boat", { api_key: "bx-e2e" })
  await signedCloud.signIn(page, signedCloud.owner)
  const starts: string[] = []
  const catalogReads: string[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname === `/api/workspace/${workspace.id}/connection`) starts.push(request.method())
    if (url.pathname === "/api/claxedo/agent-config/providers" && url.searchParams.get("nativeHarness") === "opencode") catalogReads.push(url.searchParams.get("workspaceId") ?? "")
  })
  const boots = await bootsServed(signedCloud)

  await page.goto(`${signedCloud.url}${sessionRoute(workspace.id)}`)
  await expect(page.getByText("This workspace is asleep. It wakes when you send a message.", { exact: true })).toBeVisible()
  const catalog = (await page.evaluate(async (workspaceId) => (await fetch(`/api/claxedo/agent-config/providers?nativeHarness=opencode&workspaceId=${workspaceId}&view=summary`)).json(), workspace.id)) as OpenCodeCatalog
  const openai = catalog.all.find((provider) => provider.id === "openai")
  const fallback = catalog.default.openai
  expect(Object.keys(openai?.models ?? {}).length, "the control plane lists OpenAI's models while the workspace sleeps").toBeGreaterThan(0)
  const model = fallback ? openai?.models[fallback]?.name : undefined
  if (!model) throw new Error("OpenCode's catalog names no default OpenAI model")
  const trigger = page.locator('[data-action="prompt-harness-model"]').filter({ visible: true })
  await trigger.click()
  const picker = page.getByRole("dialog", { name: "Select harness, model and effort" })
  await showHarnesses(picker)
  await picker.getByRole("button", { name: "OpenCode", exact: true }).click()
  await expect(picker.getByRole("button", { name: new RegExp(`^${model}`) }).first()).toBeVisible()
  await expect(picker.getByText("Its models load once it wakes.", { exact: true })).toHaveCount(0)
  await page.keyboard.press("Escape")
  expect(starts.filter((method) => method === "POST"), "the draft's models come without starting the workspace").toEqual([])

  const forwarded = signedCloud.controlPlaneRequests().length
  const draftReads = catalogReads.length
  await page.goto(`${signedCloud.url}/settings/models`)
  const opencode = harnessSection(page, "OpenCode")
  await opencode.getByRole("tab", { name: "Models" }).click()
  await expect(opencode.getByRole("region", { name: "OpenAI", exact: true })).toBeVisible()
  await expect(opencode.getByText(/couldn't list|can't list|once you have/)).toHaveCount(0)
  expect(catalogReads.slice(draftReads).filter((workspaceId) => workspaceId !== ""), "Settings reads OpenCode's catalog with no workspace").toEqual([])
  expect(starts.filter((method) => method === "POST"), "Settings → Models starts no workspace").toEqual([])
  expect(signedCloud.controlPlaneRequests().slice(forwarded).filter((request) => request === `POST /api/workspace/${workspace.id}/connection`)).toEqual([])
  expect(await bootsServed(signedCloud), "the server started no workspace").toBe(boots)
})
