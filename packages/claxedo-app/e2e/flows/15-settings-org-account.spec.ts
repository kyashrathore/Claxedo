import { expect, test } from "../harness"
import { harnessSection } from "./15-settings.navigation"

type AccountSourcesRead = { readonly can_manage_org_accounts: boolean; readonly sources: Readonly<Record<string, string>>; readonly org: readonly { readonly id: string; readonly provider_id: string; readonly label?: string }[] }

async function accountSources(url: string): Promise<AccountSourcesRead> {
  const response = await fetch(new URL("/api/claxedo/credentials/account-sources", url))
  expect(response.status).toBe(200)
  return await response.json() as AccountSourcesRead
}

test("15 settings: the operator adds an organization account from a harness's Add an account, chooses it, and removes it through the dialog", async ({ stack, app }) => {
  await stack.daemon.makeWorkspace("org-account", "Organization account")
  expect((await accountSources(stack.url)).can_manage_org_accounts).toBe(true)
  await app.goto(`${stack.url}/settings/models`)
  const section = harnessSection(app, "Cursor")
  const cursor = app.getByRole("radiogroup", { name: "Cursor", exact: true })
  await section.getByRole("button", { name: "Add an account" }).click()
  const drawer = app.getByRole("dialog", { name: "Connect Cursor" })
  await expect(drawer.getByRole("radio", { name: /^For me/ })).toBeChecked()
  await drawer.getByText("For the organization", { exact: true }).click()
  await expect(drawer.getByRole("radio", { name: /^For the organization/ })).toBeChecked()
  await expect(drawer.getByText("An API key anyone in your organization can choose for Cursor.", { exact: true })).toBeVisible()
  const key = drawer.getByRole("textbox", { name: "Cursor API key" })
  await key.fill("cursor-org-key")
  await drawer.getByRole("textbox", { name: "Label" }).fill("Acme Cursor")
  await drawer.getByRole("button", { name: "Continue", exact: true }).click()
  await expect(drawer.getByText(/Cursor API keys start with key_/)).toBeVisible()
  await expect(key).toHaveAttribute("aria-invalid", "true")
  expect((await accountSources(stack.url)).org.some((row) => row.label === "Acme Cursor")).toBe(false)
  await key.fill("key_org_cursor")
  await drawer.getByRole("button", { name: "Continue", exact: true }).click()
  await expect(drawer).toHaveCount(0)
  const org = cursor.locator('[data-slot="account-row"][data-account="org"]')
  await expect(org).toContainText("Acme Cursor")
  await expect(org).toContainText("Organization account")
  await expect(org.getByRole("radio")).toHaveAccessibleName(/^Acme Cursor API key · Organization account/)
  await expect(org.getByText("This computer", { exact: true })).toHaveCount(0)
  await expect(cursor.getByText("Organization", { exact: true })).toBeVisible()
  await expect(app.getByText("Sandbox providers", { exact: true })).toHaveCount(1)
  await expect(app.getByText("Team accounts", { exact: true })).toHaveCount(0)
  const saved = (await accountSources(stack.url)).org.find((row) => row.label === "Acme Cursor")
  expect(saved?.provider_id).toBe("cursor")

  await org.getByText("Acme Cursor", { exact: true }).click()
  await expect(org.getByRole("radio")).toBeChecked()
  await expect.poll(async () => (await accountSources(stack.url)).sources["cursor-sdk"]).toBe("org")
  await expect(org.getByRole("button", { name: "Check now", exact: true })).toBeEnabled()

  await org.getByRole("button", { name: "Remove", exact: true }).click()
  const confirm = app.getByRole("dialog").filter({ hasText: "Remove Acme Cursor?" })
  await expect(confirm.getByText("Used by Cursor", { exact: true })).toBeVisible()
  await confirm.getByRole("button", { name: "Remove", exact: true }).click()
  await expect(confirm).toHaveCount(0)
  await expect(org).not.toContainText("Acme Cursor")
  await expect(org.getByRole("radio")).toBeDisabled()
  expect((await accountSources(stack.url)).org.some((row) => row.id === saved?.id)).toBe(false)
})
