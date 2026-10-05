import type { Page } from "@playwright/test"
import {
  expect,
  makeCloudWorkspace,
  sendPrompt,
  sessionRoute,
  showHarnesses,
  startCloudWorkspace,
  stopCloudWorkspace,
  storeOwnerKey,
  test,
  UI,
  type SignedStack,
} from "../harness"

async function choosePi(page: Page) {
  await page.getByRole("button", { name: /^Select harness and model/ }).click()
  const picker = page.getByRole("dialog", { name: "Select harness, model and effort" })
  await showHarnesses(picker)
  await page.getByRole("button", { name: "Pi", exact: true }).click()
  await picker.getByRole("button", { name: "GPT-4.1", exact: true }).click()
  await page.keyboard.press("Escape")
}

async function recorded(signed: SignedStack, event: string) {
  return (await signed.hosted.telemetryEvents()).filter((entry) => entry.event === event)
}

test("55 a hosted reader's onboarding, cloud workspace and session reach the analytics sink allowlisted, with ids only as digests", async ({ signedCloud: signed, page }) => {
  test.setTimeout(180_000)
  await signed.signIn(page, signed.owner)
  await expect(page).toHaveURL(/\/welcome$/)
  await expect.poll(async () => (await recorded(signed, "onboarding_step_viewed")).map((entry) => entry.properties.step)).toEqual(["project"])

  await storeOwnerKey(signed, "openai", "telemetry-owner-key")
  const workspace = await makeCloudWorkspace(signed, "payments")
  await startCloudWorkspace(signed, workspace)
  await page.goto(`${signed.url}${sessionRoute(workspace.id)}`)
  await choosePi(page)
  await sendPrompt(page, "Reply with exactly this one token: TELEMETRYSEND")
  await expect(page.getByText("TELEMETRYSEND", { exact: true })).toBeVisible({ timeout: 120_000 })
  await stopCloudWorkspace(signed, { id: workspace.id, projectId: workspace.projectId })

  await expect.poll(async () => (await recorded(signed, "session_started")).map((entry) => entry.properties)).toEqual([
    expect.objectContaining({ harness: "pi", where: "cloud" }),
  ])
  await expect.poll(async () => (await recorded(signed, "workspace_created")).length).toBe(1)
  await expect.poll(async () => (await recorded(signed, "workspace_ready")).map((entry) => entry.properties.start_ms)).toEqual([expect.any(Number)])
  await expect.poll(async () => (await recorded(signed, "workspace_stopped")).map((entry) => entry.properties)).toEqual([
    expect.objectContaining({ cause: "explicit", active_ms: expect.any(Number) }),
  ])

  const events = await signed.hosted.telemetryEvents()
  const sent = JSON.stringify(events)
  for (const secret of [signed.owner.email, workspace.id, workspace.projectId, "TELEMETRYSEND", "telemetry-owner-key", signed.hosted.gitUrl]) {
    expect(sent).not.toContain(secret)
  }
  for (const event of await recorded(signed, "session_started")) {
    expect(event.distinct_id).toMatch(/^[0-9a-f]{32}$/)
    expect(Object.keys(event.properties).toSorted()).toEqual(["$groups", "harness", "org_id", "where"])
  }
  expect(events.map((entry) => entry.event)).not.toContain("control_plane.auth.signed")
  await expect(page.getByRole("textbox", { name: UI.composer })).toBeVisible()
})
