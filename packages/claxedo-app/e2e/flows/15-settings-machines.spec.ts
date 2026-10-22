import type { Locator, Page } from "@playwright/test"
import { enrollOwnerMachine, expect, ownerDevices, test, type SignedStack } from "../harness"
import { hostedFetch } from "../../../harness/e2e/harness/hosted-auth"

const HOPS = ["This device to Claxedo", "Claxedo to Signed fixture machine", "Signed fixture machine answering through the relay"] as const
const MACHINE = "Signed fixture machine"

async function machines(app: Page, url: string) {
  await app.goto(`${url}/settings/machines`)
  await expect(app.getByRole("heading", { level: 1, name: "Machines" })).toBeVisible()
  await expect(app.getByRole("group", { name: "Remote access" })).toHaveCount(0)
  return app.getByRole("group", { name: "Your machines" })
}

async function openConnect(app: Page, name: string) {
  await app.getByRole("button", { name: "Connect a machine…" }).click()
  const drawer = app.getByRole("dialog", { name: "Connect a machine" })
  await expect(drawer.getByText("Another machine you own", { exact: true })).toBeVisible()
  await drawer.getByRole("textbox", { name: "Machine name" }).fill(name)
  await expect(drawer.getByText(`claxedo host invite --name ${name} --root ~/code`, { exact: true })).toBeVisible()
  await expect(drawer.getByRole("button", { name: "Copy invite command" })).toBeVisible()
  await drawer.getByRole("button", { name: "I've run it" }).click()
  await expect(drawer.getByText(`Waiting for ${name}…`, { exact: true })).toBeVisible()
  await expect(drawer.getByRole("button", { name: "Check again" })).toBeVisible()
  return drawer
}

async function openDetails(app: Page, url: string): Promise<Locator> {
  const yours = await machines(app, url)
  await yours.getByRole("button", { name: `${MACHINE} details` }).click()
  return app.getByRole("dialog", { name: MACHINE })
}

async function expectHops(details: Locator, statuses: readonly string[]) {
  for (const [index, hop] of HOPS.entries()) await expect(details.getByRole("listitem").filter({ hasText: hop })).toContainText(statuses[index] ?? "")
}

async function deviceState(signed: SignedStack) {
  return (await ownerDevices(signed)).find((device) => device.display_name === MACHINE)
}

async function runtimeAnswers(signed: SignedStack, workspaceId: string) {
  const answered = await signed.runtime(workspaceId)({ method: "GET", url: "http://runtime.local/global/health", headers: {} })
  return answered.status
}

test("15 Machines lists the machine the app runs on with its state, and Connect a machine opens the instructions and waits for the new machine", async ({ stack, app }) => {
  const yours = await machines(app, stack.url)
  await expect(yours.getByText(/^You're on this machine/)).toHaveCount(1)
  await expect(yours.getByText("This computer", { exact: true })).toHaveCount(0)
  await expect(yours.getByRole("button", { name: /details$/ })).toHaveCount(0)
  await expect(app.getByText("No machine is connected yet.", { exact: true })).toHaveCount(0)
  const drawer = await openConnect(app, "build-box")
  await drawer.getByRole("button", { name: "Done" }).click()
  await expect(drawer).toHaveCount(0)
})

test("15 Machines on the web lists each machine by name with its state and when it was last seen", async ({ signed, page }) => {
  await page.goto(`${signed.url}/`)
  await signed.signIn(page, signed.owner)
  const devices = await hostedFetch(signed.hosted, "/api/claxedo/remote-access/devices", {}, signed.owner.person)
  const [device] = (await devices.json() as { devices: Array<{ display_name: string; state: string }> }).devices
  expect(device).toMatchObject({ display_name: MACHINE, state: "online" })
  const yours = await machines(page, signed.url)
  await expect(yours.getByText(MACHINE, { exact: true })).toBeVisible()
  await expect(yours.getByText(/^Online · last seen /)).toHaveCount(1)
  await expect(page.getByText("Not available yet", { exact: true })).toHaveCount(0)
})

test("15 Machine details check each hop in order, name the one that fails, and recover on Check again", async ({ signed, page, context }, testInfo) => {
  const folder = await signed.makeWorkspace("probe-folder")
  await page.goto(`${signed.url}/`)
  await signed.signIn(page, signed.owner)
  const details = await openDetails(page, signed.url)
  await expect(details.getByText(`${MACHINE} is connected`, { exact: true })).toBeVisible()
  await expectHops(details, ["Works", "Works", "Works"])
  await page.screenshot({ path: testInfo.outputPath("machine-details-connected.png") })

  await context.setOffline(true)
  await details.getByRole("button", { name: "Check again" }).click()
  await expect(details.getByText("This device can't reach Claxedo", { exact: true })).toBeVisible()
  await expectHops(details, ["Failed", "Not checked", "Not checked"])
  await expect(details.getByText("Check this device's internet connection, then check again.", { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("machine-details-device-offline.png") })
  await context.setOffline(false)
  await details.getByRole("button", { name: "Check again" }).click()
  await expect(details.getByText(`${MACHINE} is connected`, { exact: true })).toBeVisible()

  await signed.local.daemon.close()
  await details.getByRole("button", { name: "Check again" }).click()
  await expect(details.getByText(`${MACHINE} is online, but Claxedo there didn't answer`, { exact: true })).toBeVisible()
  await expectHops(details, ["Works", "Works", "Failed"])
  await expect(details.getByText(`Run \`claxedo doctor\` on ${MACHINE}, or restart Claxedo there.`, { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("machine-details-runtime-failed.png") })
  await signed.local.daemon.restart()
  await expect.poll(() => runtimeAnswers(signed, folder.id), { timeout: 30_000 }).toBe(200)
  await details.getByRole("button", { name: "Check again" }).click()
  await expect(details.getByText(`${MACHINE} is connected`, { exact: true })).toBeVisible()
  expect(await deviceState(signed)).toMatchObject({ state: "online", serving_workspace_ids: [folder.id] })
})

test("15 Pause stops a machine until Resume, and Remove asks first and says its sessions stay in history", async ({ signed, page }, testInfo) => {
  await page.goto(`${signed.url}/`)
  await signed.signIn(page, signed.owner)
  const details = await openDetails(page, signed.url)
  await expect(details.getByText(`${MACHINE} is connected`, { exact: true })).toBeVisible()
  await details.getByRole("button", { name: "Pause", exact: true }).click()
  await expect(details.getByText(`Paused: nothing reaches ${MACHINE} until you resume it`, { exact: true })).toBeVisible()
  await expect(details.getByText(`${MACHINE} is paused`, { exact: true })).toBeVisible()
  await expectHops(details, ["Works", "Failed", "Not checked"])
  expect((await deviceState(signed))?.state).toBe("paused")
  await page.screenshot({ path: testInfo.outputPath("machine-details-paused.png") })

  await details.getByRole("button", { name: "Resume", exact: true }).click()
  await expect(details.getByText(`Resumed: ${MACHINE} can serve again once it checks in`, { exact: true })).toBeVisible()
  await expect(details.getByRole("button", { name: "Pause", exact: true })).toBeVisible()
  expect((await deviceState(signed))?.state).not.toBe("paused")

  await details.getByRole("button", { name: "Remove", exact: true }).click()
  const confirm = page.getByRole("dialog", { name: `Remove ${MACHINE}?` })
  await expect(confirm.getByText("Its sessions stay in history; new ones can't start there until you add it again.", { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("machine-remove-confirm.png") })
  await confirm.getByRole("button", { name: "Cancel" }).click()
  await expect(confirm).toHaveCount(0)
  expect(await deviceState(signed)).toBeTruthy()
  await details.getByRole("button", { name: "Remove", exact: true }).click()
  await page.getByRole("dialog", { name: `Remove ${MACHINE}?` }).getByRole("button", { name: "Remove" }).click()
  await expect(details).toHaveCount(0)
  await expect(page.getByText(`${MACHINE} removed`, { exact: true })).toBeVisible()
  await expect(page.getByText("No machine is connected yet.", { exact: true })).toBeVisible()
  expect(await ownerDevices(signed)).toEqual([])
})

test("15 Connect a machine waits for the new machine and says when it is connected", async ({ signed, page }, testInfo) => {
  await page.goto(`${signed.url}/`)
  await signed.signIn(page, signed.owner)
  await machines(page, signed.url)
  const drawer = await openConnect(page, "studio-box")
  await page.screenshot({ path: testInfo.outputPath("connect-waiting.png") })
  await enrollOwnerMachine(signed, "studio-box")
  await drawer.getByRole("button", { name: "Check again" }).click()
  await expect(drawer.getByText("studio-box is connected", { exact: true })).toBeVisible()
  await expect(drawer.getByRole("button", { name: "Check again" })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath("connect-connected.png") })
  expect((await ownerDevices(signed)).map((device) => device.display_name).toSorted()).toEqual([MACHINE, "studio-box"])
  await drawer.getByRole("button", { name: "Done" }).click()
  await expect(page.getByRole("group", { name: "Your machines" }).getByText("studio-box", { exact: true })).toBeVisible()
})
