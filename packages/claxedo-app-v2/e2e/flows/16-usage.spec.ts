import type { Page } from "@playwright/test"
import { expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, UI, type Stack } from "../harness"

type QuotaRead = { readonly harness: string; readonly label?: string; readonly windows: readonly unknown[]; readonly usageError?: string }

type UsageRead = {
  readonly claxedo: { readonly totals: { readonly turnCount: number } }
  readonly quota: { readonly status: string; readonly refreshing?: true; readonly snapshot?: { readonly accounts: readonly QuotaRead[] } }
}

async function usage(url: string, view: "quota" | "claxedo"): Promise<UsageRead> {
  const now = Date.now()
  const query = new URLSearchParams({ since: String(now - 86_400_000), until: String(now + 86_400_000), timezone: "UTC", view, group: "provider", limit: "25" })
  const response = await fetch(new URL(`/api/claxedo/usage?${query}`, url))
  expect(response.status).toBe(200)
  return (await response.json()) as UsageRead
}

async function openUsage(stack: Stack, app: Page, isMobile: boolean) {
  if (isMobile) await app.getByRole("button", { name: UI.openRail }).click()
  await app.getByRole("button", { name: UI.signedOutAccount }).click()
  await app.getByRole("menuitem", { name: "Usage" }).click()
  if (stack.app !== "v2") return app.getByRole("dialog", { name: "Usage" })
  return await test.step("v2 approved: Usage opens Settings → Usage (DECISIONS Owner, 20:00)", async () => {
    await expect(app).toHaveURL(/\/settings\/usage$/)
    return app.getByRole("region", { name: "Usage" })
  })
}

test("16 usage: quota windows and the turns Claxedo ran", async ({ stack, api, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("usage", "Usage")
  const session = await api.createSession(workspace.directory, { title: "Metered", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, session.id, "Count this turn")
  await expect.poll(async () => (await usage(stack.url, "claxedo")).claxedo.totals.turnCount).toBe(1)
  await expect.poll(async () => (await usage(stack.url, "quota")).quota.refreshing ?? false).toBe(false)
  const accounts = (await usage(stack.url, "quota")).quota.snapshot?.accounts ?? []

  await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
  const dialog = await openUsage(stack, app, isMobile)
  const v2 = stack.app === "v2"
  const views = dialog.getByRole("group", { name: v2 ? "Usage view" : "Usage views" })
  await expect(views.getByRole("button", { name: "Usage limits" })).toHaveAttribute("aria-pressed", "true")
  const limits = dialog.getByRole("region", { name: "Quota windows" })
  await expect(limits.getByRole("article")).toHaveCount(accounts.length)
  for (const account of accounts) {
    const card = limits.getByRole("article").filter({ hasText: account.label ?? account.harness })
    await expect(card.getByRole("progressbar")).toHaveCount(account.windows.length)
    if (account.usageError) await expect(card).toContainText(account.usageError)
  }

  await views.getByRole("button", { name: "Usage through Claxedo" }).click()
  await expect(views.getByRole("button", { name: "Usage through Claxedo" })).toHaveAttribute("aria-pressed", "true")
  if (v2) {
    await test.step("v2 approved: Usage through Claxedo shows its totals as a list (DECISIONS Owner, 00:50)", async () => {
      await expect(dialog.getByRole("definition").first()).toHaveText("1")
    })
  } else {
    await expect(dialog.getByRole("complementary", { name: "Processed tokens" })).toContainText("1 turn")
  }
  const byProvider = dialog.getByRole("table", { name: "Usage grouped by provider" })
  await expect(byProvider.getByRole("row")).toHaveCount(2)

  await dialog.getByRole("button", { name: "Model", exact: true }).click()
  await expect(dialog.getByRole("table", { name: "Usage grouped by model" }).getByRole("row")).toHaveCount(2)
  await expect(byProvider).toHaveCount(0)

  await dialog.getByRole("button", { name: "Cost", exact: true }).click()
  if (v2) {
    await test.step("v2 approved: the cost measure names its column Estimated cost (DECISIONS Owner, 00:50)", async () => {
      await expect(dialog.getByRole("table", { name: "Usage grouped by model" }).getByRole("columnheader", { name: "Estimated cost" })).toBeVisible()
    })
  } else {
    await expect(dialog.getByRole("complementary", { name: "Estimated raw token cost" })).toContainText("1 turn")
    await expect(dialog.getByRole("table", { name: "Usage grouped by model" }).getByRole("columnheader", { name: "Est. cost" })).toBeVisible()
  }
  await expect(dialog.getByRole("button", { name: "90 days", exact: true })).toBeVisible()
  expect(await app.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
