import { hostname } from "node:os"
import type { Locator, Page, TestInfo } from "@playwright/test"
import { connectFolder, expect, startConnectCli, type ConnectCli, type SignedStack } from "../harness"

export const MACHINE = "Signed fixture machine"

export async function machines(app: Page, url: string) {
  await app.goto(`${url}/settings/machines`)
  await expect(app.getByRole("heading", { level: 1, name: "Machines" })).toBeVisible()
  await expect(app.getByRole("group", { name: "Remote access" })).toHaveCount(0)
  return app.getByRole("group", { name: "Your machines" })
}

export const PAIRING_COMMAND = /^curl -fsSL https:\/\/\S+\/api\/claxedo\/connect \| sh -s -- [0-9A-Z]{20}$/
export const HOSTNAME = hostname()

export async function openPairing(app: Page) {
  await app.getByRole("button", { name: "Connect a machine…" }).click()
  const drawer = app.getByRole("dialog", { name: "Connect a machine" })
  const command = drawer.getByText(PAIRING_COMMAND)
  await expect(command).toBeVisible()
  await expect(drawer.getByText("Waiting for the command…", { exact: true })).toBeVisible()
  await expect(drawer.getByText(/^Code valid 1[45]:\d\d$/)).toBeVisible()
  const code = (await command.textContent())?.split(" ").at(-1) ?? ""
  return { drawer, code }
}

export async function pairedMachine(signed: SignedStack, code: string, testInfo: TestInfo, run: (cli: ConnectCli) => Promise<void>) {
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

export const approvalCard = (scope: Locator) => scope.getByRole("region", { name: `Approve ${HOSTNAME}?` })

export const connectWay = (drawer: Locator, way: "Paste a command" | "Over SSH" | "New server") =>
  drawer.getByRole("group", { name: "How will you reach the machine?" }).getByRole("button", { name: way, exact: true })
