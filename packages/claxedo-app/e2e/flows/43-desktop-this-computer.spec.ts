import { expect, test, UI } from "../harness"

type MachineReport = { readonly displayName?: string; readonly status?: string }

test("43 desktop this computer: Settings → Machines shows the computer the desktop runs on, under its own name", { tag: "@desktop" }, async ({ desktop }) => {
  await desktop.makeWorkspace("desktop-this-computer", "This computer")
  const window = desktop.window
  await window.reload()
  const report = await window.evaluate(async () => {
    const api = (globalThis as unknown as { api: { hostConnector: { status: () => Promise<MachineReport> } } }).api
    return api.hostConnector.status()
  })
  expect(report.displayName).toBeTruthy()
  expect(report.status).not.toBe("enrolled")

  await window.getByRole("button", { name: UI.signInAccount, exact: true }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("link", { name: "Machines", exact: true }).click()
  await expect(window.getByRole("heading", { level: 1, name: "Machines" })).toBeVisible()

  const yours = window.getByRole("group", { name: "Your machines" })
  await expect(yours.getByText(report.displayName ?? "", { exact: true })).toBeVisible()
  await expect(yours.getByText("This computer", { exact: true })).toBeVisible()
  await expect(yours.getByText("Connected · only reachable from this computer", { exact: true })).toBeVisible()
  await expect(yours.getByText("No machine is enrolled yet", { exact: false })).toHaveCount(0)
})
