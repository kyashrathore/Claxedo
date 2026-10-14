import type { Locator, Page } from "@playwright/test"
import { expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, UI, type Stack } from "../harness"
import { openSection } from "./15-settings.navigation"

type QuotaRead = {
  readonly harness: string
  readonly label?: string
  readonly otherAgent?: true
  readonly inUse: boolean
  readonly windows: readonly unknown[]
  readonly usageError?: string
}

type UsageRead = {
  readonly claxedo: {
    readonly totals: { readonly turnCount: number }
    readonly cost: { readonly pricedTokens: number }
  }
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
  return await test.step("Usage opens Settings → Usage limits (DECISIONS Owner, 20:00; owner, 2026-10-14)", async () => {
    await expect(app).toHaveURL(/\/settings\/usage-limits$/)
    return app.getByRole("region", { name: "Usage limits" })
  })
}

async function top(locator: Locator): Promise<number> {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  return box?.y ?? Number.NaN
}

test("16 usage: quota windows and the turns Claxedo ran", async ({ stack, api, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("usage", "Usage")
  const session = await api.createSession(workspace.directory, { title: "Metered", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, session.id, "Count this turn")
  await expect.poll(async () => (await usage(stack.url, "claxedo")).claxedo.totals.turnCount).toBe(1)
  await expect.poll(async () => (await usage(stack.url, "quota")).quota.refreshing ?? false).toBe(false)
  const accounts = (await usage(stack.url, "quota")).quota.snapshot?.accounts ?? []
  const notConnected = accounts.filter((account) => account.otherAgent && account.windows.length === 0)
  const shown = accounts.filter((account) => !notConnected.includes(account))

  await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
  const dialog = await openUsage(stack, app, isMobile)
  await test.step("usage limits, AI usage and sandbox usage are pages of their own, and sandbox usage is hidden where cloud sandboxes are not offered (owner, 2026-10-14)", async () => {
    await expect(app.getByRole("link", { name: "Usage limits", exact: true })).toHaveAttribute("aria-current", "page")
    await expect(app.getByRole("link", { name: "AI usage", exact: true })).toHaveCount(1)
    await expect(app.getByRole("link", { name: "Sandbox usage", exact: true })).toHaveCount(0)
    await expect(dialog.getByRole("group", { name: "Usage view" })).toHaveCount(0)
  })
  const limits = dialog.getByRole("region", { name: "Quota windows" })
  await expect(limits.getByRole("article")).toHaveCount(shown.length)
  for (const account of shown) {
    const card = limits.getByRole("article").filter({ hasText: account.label ?? account.harness })
    await expect(card.getByRole("progressbar")).toHaveCount(account.windows.length)
    if (account.usageError) await expect(card).toContainText(account.usageError)
  }
  await test.step("agents that report no plan wait in one collapsed Not connected group (owner, 2026-09-28)", async () => {
    const toggle = limits.getByRole("button", { name: /^Not connected/ })
    await expect(toggle).toHaveCount(notConnected.length > 0 ? 1 : 0)
    if (notConnected.length === 0) return
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await toggle.click()
    for (const agent of notConnected) if (agent.usageError) await expect(limits).toContainText(agent.usageError)
  })

  await openSection(app, isMobile, "AI usage")
  await expect(app).toHaveURL(/\/settings\/ai-usage$/)
  const ai = app.getByRole("region", { name: "AI usage" })
  const range = ai.getByRole("group", { name: "Range" })
  const measure = ai.getByRole("group", { name: "Measure" })
  await test.step("range and measure share one control row at this width (owner, 2026-09-28)", async () => {
    expect(await top(measure)).toBe(await top(range))
  })
  const totals = ai.getByRole("definition")
  await test.step("the chosen measure leads the totals, then turns (DECISIONS Owner, 00:50)", async () => {
    await expect(totals.nth(1)).toHaveText("1")
  })
  const read = await usage(stack.url, "claxedo")
  await test.step("a cost no price covers reads Unknown, never $0.00 (owner, 2026-09-28)", async () => {
    expect(read.claxedo.cost.pricedTokens).toBe(0)
    await expect(totals.nth(2)).toHaveText("Unknown")
  })
  await expect(ai.getByRole("group", { name: "Daily usage" })).toBeVisible()
  await expect(ai.getByRole("region", { name: "Where the tokens went" })).toBeVisible()
  const byProvider = ai.getByRole("table", { name: "Usage grouped by provider" })
  await expect(byProvider.getByRole("row")).toHaveCount(2)
  await expect(byProvider.getByRole("row").nth(1).getByRole("cell").last()).toHaveText("Unknown")

  await ai.getByRole("group", { name: "Group by" }).getByRole("button", { name: "Model", exact: true }).click()
  await expect(ai.getByRole("table", { name: "Usage grouped by model" }).getByRole("row")).toHaveCount(2)
  await expect(byProvider).toHaveCount(0)

  await measure.getByRole("button", { name: "Cost", exact: true }).click()
  await test.step("the cost measure leads with the estimated cost (DECISIONS Owner, 00:50)", async () => {
    await expect(ai.getByRole("term").first()).toHaveText("Estimated cost")
    await expect(ai.getByRole("table", { name: "Usage grouped by model" }).getByRole("columnheader", { name: "Estimated cost" })).toBeVisible()
  })
  await expect(range.getByRole("button", { name: "90 days", exact: true })).toBeVisible()
  expect(await app.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
