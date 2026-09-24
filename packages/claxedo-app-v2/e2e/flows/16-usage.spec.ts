import { expect, SCRIPTED_ACP_HARNESS, test } from "../harness"

type QuotaRead = { readonly harness: string; readonly label?: string; readonly windows: readonly unknown[] }

type UsageRead = {
  readonly claxedo: { readonly totals: { readonly turnCount: number } }
  readonly quota: { readonly status: string; readonly error?: string; readonly refreshing?: true; readonly snapshot?: { readonly accounts: readonly QuotaRead[] } }
}

async function createProject(url: string, name: string, directory: string): Promise<void> {
  const response = await fetch(new URL("/api/claxedo/projects", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, source: { kind: "directory", directory } }),
  })
  expect(response.status).toBe(201)
}

async function usage(url: string, view: "quota" | "claxedo"): Promise<UsageRead> {
  const now = Date.now()
  const query = new URLSearchParams({ since: String(now - 86_400_000), until: String(now + 86_400_000), timezone: "UTC", view, group: "provider", limit: "25" })
  const response = await fetch(new URL(`/api/claxedo/usage?${query}`, url))
  expect(response.status).toBe(200)
  return (await response.json()) as UsageRead
}

test("16 usage: quota windows and the turns Claxedo ran", async ({ stack, api, app }) => {
  test.skip(stack.app === "v1", "the v1 path of this baseline flow is not written yet")
  const workspace = await stack.daemon.makeWorkspace("usage")
  await createProject(stack.url, "Usage", workspace.directory)
  const session = await api.createSession(workspace.directory, { title: "Metered", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, session.id, "Count this turn")
  await expect.poll(async () => (await usage(stack.url, "claxedo")).claxedo.totals.turnCount).toBe(1)
  await expect.poll(async () => (await usage(stack.url, "quota")).quota.refreshing ?? false).toBe(false)
  const quota = (await usage(stack.url, "quota")).quota

  await app.goto(`${stack.url}/settings/usage`)
  await expect(app.getByRole("heading", { level: 1, name: "Usage" })).toBeVisible()
  const views = app.getByRole("group", { name: "Usage view" })
  await expect(views.getByRole("button", { name: "Usage limits" })).toHaveAttribute("aria-pressed", "true")
  const limits = app.getByRole("region", { name: "Quota windows" })
  const accounts = quota.snapshot?.accounts ?? []
  await expect(limits.getByRole("article")).toHaveCount(accounts.length)
  for (const account of accounts) {
    const card = limits.getByRole("article", { name: account.label ?? account.harness })
    await expect(card.getByRole("progressbar")).toHaveCount(account.windows.length)
  }
  await expect(app.getByText("Checking your agents…")).toHaveCount(0)
  await expect(app.getByRole("alert")).toHaveText(quota.status === "available" ? [] : [quota.error ?? "Usage limits are unavailable"])

  await views.getByRole("button", { name: "Usage through Claxedo" }).click()
  await expect(views.getByRole("button", { name: "Usage through Claxedo" })).toHaveAttribute("aria-pressed", "true")
  const totals = app.getByLabel("Totals")
  await expect(totals.getByRole("definition").first()).toHaveText("1")
  const byProvider = app.getByRole("table", { name: "Usage grouped by provider" })
  await expect(byProvider.getByRole("row")).toHaveCount(2)
  await expect(byProvider.getByRole("row").nth(1).getByRole("cell").first()).toHaveText("1")

  await app.getByRole("group", { name: "Group by" }).getByRole("button", { name: "Model" }).click()
  await expect(app.getByRole("table", { name: "Usage grouped by model" }).getByRole("row")).toHaveCount(2)
  await expect(byProvider).toHaveCount(0)

  await app.getByRole("group", { name: "Measure" }).getByRole("button", { name: "Cost" }).click()
  await expect(app.getByRole("table", { name: "Usage grouped by model" }).getByRole("columnheader", { name: "Estimated cost" })).toBeVisible()
  expect(await app.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
