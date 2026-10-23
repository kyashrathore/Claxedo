import { hostname } from "node:os"
import type { Locator, Page, TestInfo } from "@playwright/test"
import { connectFolder, expect, ownerDevices, startConnectCli, test, type ConnectCli, type SignedStack } from "../harness"
import { hostedFetch } from "../../../harness/e2e/harness/hosted-auth"

const HOPS = ["This device to Claxedo", "Claxedo to Signed fixture machine", "Signed fixture machine answering through the relay"] as const
const MACHINE = "Signed fixture machine"

async function machines(app: Page, url: string) {
  await app.goto(`${url}/settings/machines`)
  await expect(app.getByRole("heading", { level: 1, name: "Machines" })).toBeVisible()
  await expect(app.getByRole("group", { name: "Remote access" })).toHaveCount(0)
  return app.getByRole("group", { name: "Your machines" })
}

const PAIRING_COMMAND = /^curl -fsSL https:\/\/\S+\/api\/claxedo\/connect \| sh -s -- [0-9A-Z]{20}$/
const HOSTNAME = hostname()

async function openPairing(app: Page) {
  await app.getByRole("button", { name: "Connect a machine…" }).click()
  const drawer = app.getByRole("dialog", { name: "Connect a machine" })
  const command = drawer.getByText(PAIRING_COMMAND)
  await expect(command).toBeVisible()
  await expect(drawer.getByText("Waiting for the command…", { exact: true })).toBeVisible()
  await expect(drawer.getByText(/^Code valid 1[45]:\d\d$/)).toBeVisible()
  const code = (await command.textContent())?.split(" ").at(-1) ?? ""
  return { drawer, code }
}

async function pairedMachine(signed: SignedStack, code: string, testInfo: TestInfo, run: (cli: ConnectCli) => Promise<void>) {
  const where = await connectFolder("app")
  const cli = startConnectCli(signed, { code, home: where.home, folder: where.folder })
  try {
    await run(cli)
  } finally {
    await cli.stop()
    await testInfo.attach("claxedo connect", { body: cli.lines().join("\n"), contentType: "text/plain" })
    await where.close()
  }
}

const approvalCard = (scope: Locator) => scope.getByRole("region", { name: `Approve ${HOSTNAME}?` })

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

test("15 Machines lists the machine the app runs on with its state, and Connect a machine asks to sign in before it makes a code", async ({ stack, app }) => {
  const yours = await machines(app, stack.url)
  await expect(yours.getByText(/^You're on this machine/)).toHaveCount(1)
  await expect(yours.getByText("This computer", { exact: true })).toHaveCount(0)
  await expect(yours.getByRole("button", { name: /details$/ })).toHaveCount(0)
  await expect(app.getByText("No machine is connected yet.", { exact: true })).toHaveCount(0)
  await app.getByRole("button", { name: "Connect a machine…" }).click()
  const drawer = app.getByRole("dialog", { name: "Connect a machine" })
  await expect(drawer.getByText("Sign in to Claxedo here to connect another machine.", { exact: true })).toBeVisible()
  await expect(drawer.getByText(PAIRING_COMMAND)).toHaveCount(0)
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

test("15 Connect a machine pairs a machine with one pasted command: it asks for approval, Approve shares the folder it ran in, and the drawer says it is ready", async ({ signed, page }, testInfo) => {
  await page.goto(`${signed.url}/`)
  await signed.signIn(page, signed.owner)
  await machines(page, signed.url)
  const { drawer, code } = await openPairing(page)
  await drawer.getByRole("tab", { name: "Windows" }).click()
  await expect(drawer.getByText(`& ([scriptblock]::Create((irm ${signed.url}/api/claxedo/connect.ps1))) ${code}`, { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("pairing-command.png") })
  await pairedMachine(signed, code, testInfo, async (cli) => {
    const card = approvalCard(drawer)
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card.getByText(cli.folder, { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath("pairing-approval.png") })
    await card.getByRole("textbox", { name: "Name" }).fill("paired-box")
    await card.getByRole("button", { name: "Approve" }).click()
    await expect(drawer.getByText("app on paired-box is ready", { exact: true })).toBeVisible({ timeout: 30_000 })
    await page.screenshot({ path: testInfo.outputPath("pairing-ready.png") })
    const paired = (await ownerDevices(signed)).find((device) => device.display_name === "paired-box")
    expect(paired?.state).toBe("online")
    expect(paired?.serving_workspace_ids).toHaveLength(1)
    expect(cli.lines()).toContain("approved by the owner: serving")
  })
  await drawer.getByRole("button", { name: "Done" }).click()
  await expect(page.getByRole("group", { name: "Your machines" }).getByText("paired-box", { exact: true })).toBeVisible()
})

test("15 Connect a machine: a machine its owner denies is told so and exits, and the drawer says it was denied", async ({ signed, page }, testInfo) => {
  await page.goto(`${signed.url}/`)
  await signed.signIn(page, signed.owner)
  await machines(page, signed.url)
  const { drawer, code } = await openPairing(page)
  await pairedMachine(signed, code, testInfo, async (cli) => {
    const card = approvalCard(drawer)
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.getByRole("button", { name: "Deny" }).click()
    await expect(drawer.getByText(`You denied ${HOSTNAME}`, { exact: true })).toBeVisible()
    expect(await cli.exited).toBe(78)
    expect(cli.lines()).toContain("The owner denied this machine in Claxedo.")
  })
  expect((await ownerDevices(signed)).map((device) => device.display_name)).toEqual([MACHINE])
})

test("15 Machines lists a machine asking to join while no drawer is open, and approving it there connects it", async ({ signed, page }, testInfo) => {
  await page.goto(`${signed.url}/`)
  await signed.signIn(page, signed.owner)
  await machines(page, signed.url)
  const { drawer, code } = await openPairing(page)
  await drawer.getByRole("button", { name: "Done" }).click()
  await pairedMachine(signed, code, testInfo, async () => {
    const requests = page.getByRole("group", { name: "Waiting for your approval" })
    const card = approvalCard(requests)
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.getByRole("button", { name: "Approve" }).click()
    await expect(requests).toHaveCount(0)
    await expect(page.getByRole("group", { name: "Your machines" }).getByText(HOSTNAME, { exact: true })).toBeVisible()
  })
})
