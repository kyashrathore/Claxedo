/**
 * SPEC: Unified usage dashboard (Tier M)
 *
 * The real account-menu entrypoint opens the Settings-sized dashboard. Only
 * the versioned usage API is mocked; query changes, focus restoration,
 * accessibility, and responsive dialog behavior run through production UI.
 */
import { AxeBuilder } from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"

const DIR = "/tmp/e2e-core-usage-dashboard"
const SESSION_ID = "ses_core_usage_dashboard"

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function seedOneProject(page: Page) {
  await page.addInitScript((dir: string) => {
    localStorage.clear()
    ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
      serverUrl: window.location.origin,
      activeDirectory: dir,
    }
    localStorage.setItem("opencode.global.dat:server", JSON.stringify({
      list: [],
      projects: { local: [{ worktree: dir, expanded: true }] },
      lastProject: {},
      workspaceServer: {},
      closedProjects: {},
    }))
  }, DIR)
}

const totals = (turnCount: number, input: number, output: number) => ({
  turnCount,
  input,
  output,
  reasoning: 100,
  cacheRead: 200,
  cacheWrite: 50,
  unknownCategories: 0,
})

const cost = (estimatedUsd: number) => ({
  estimatedUsd,
  pricedTokens: 2_350,
  unpricedTokens: 0,
  catalog: { adapter: "tokentracker-cli", version: "0.75.1", source: "fixture" },
})

function response(url: URL) {
  const since = Number(url.searchParams.get("since"))
  const until = Number(url.searchParams.get("until"))
  const group = url.searchParams.get("group") ?? "harness"
  return {
    version: 1,
    range: { since, until, timeZone: url.searchParams.get("timezone") ?? "UTC" },
    quota: {
      status: "available",
      snapshot: {
        anthropic: { configured: true, five_hour: { utilization: 25, resets_at: "2026-08-09T15:00:00Z" } },
        openai: { configured: true, weekly: { used_percent: 40, reset_at: "2026-08-16T00:00:00Z" } },
      },
    },
    claxedo: {
      totals: totals(8, 1_000, 1_000),
      daily: [{ date: "2026-08-09", ...totals(8, 1_000, 1_000) }],
      cost: cost(0.0142),
      status: "available",
      scope: "cross-machine",
    },
    externalLocal: {
      totals: totals(2, 200, 100),
      daily: [{ date: "2026-08-09", ...totals(2, 200, 100) }],
      cost: cost(0.003),
      status: "available",
      coverage: [{ source: "claude", status: "available" }],
      unclassified: 1,
    },
    total: {
      totals: totals(10, 1_200, 1_100),
      daily: [{ date: "2026-08-09", ...totals(10, 1_200, 1_100) }],
    },
    totalCost: cost(0.0172),
    sync: { attempted: 1, delivered: 1, conflicts: 0, pending: 0 },
    breakdown: {
      dimension: group,
      localRows: [
        { value: group === "app" ? "claude" : "claude-sdk", turnCount: 2, input: 200, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      ],
      central: {
        rows: [{ value: group === "app" ? "claxedo" : "codex-app-server", turn_count: 8, input_tokens: 1_000, output_tokens: 1_000, reasoning_tokens: 100, cache_read_tokens: 200, cache_write_tokens: 50 }],
      },
    },
  }
}

async function arrange(page: Page) {
  await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
  const requests: URL[] = []
  await page.route("**/api/claxedo/usage**", async (route) => {
    const url = new URL(route.request().url())
    requests.push(url)
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response(url)) })
  })
  await seedOneProject(page)
  await page.goto(`/${slug(DIR)}/session`, { waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  return requests
}

async function openUsage(page: Page) {
  const trigger = page.getByTestId("rail-account-trigger")
  await trigger.focus()
  await page.keyboard.press("Enter")
  await page.getByRole("menuitem", { name: "Usage", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Usage" })
  await expect(dialog).toBeVisible()
  return { dialog, trigger }
}

test.describe("unified usage dashboard @core @surface-web", () => {
  test("opens from the account menu, reconciles cards, queries controls, and restores focus", async ({ page }) => {
    const requests = await arrange(page)
    const { dialog, trigger } = await openUsage(page)

    await expect(dialog.getByRole("button", { name: /Claxedo usage/ })).toHaveAttribute("aria-pressed", "true")
    await expect(dialog.getByRole("button", { name: /Claxedo usage/ })).toContainText("2.4K")
    await expect(dialog.getByRole("button", { name: /Total usage/ })).toContainText("2.7K")
    await expect(dialog.getByRole("button", { name: "30d" })).toHaveAttribute("aria-pressed", "true")
    await expect(dialog.getByRole("button", { name: "Tokens" })).toHaveAttribute("aria-pressed", "true")
    await expect(dialog.getByRole("table", { name: "Usage grouped by harness" })).toContainText("codex-app-server")
    await expect(dialog).toContainText("1 local events quarantined")

    await dialog.getByRole("button", { name: /Total usage/ }).click()
    await expect(dialog.getByRole("button", { name: /Total usage/ })).toHaveAttribute("aria-pressed", "true")
    await expect.poll(() => requests.at(-1)?.searchParams.get("group")).toBe("app")
    await dialog.getByRole("button", { name: "7d" }).click()
    await expect.poll(() => {
      const request = requests.at(-1)
      return request ? Number(request.searchParams.get("until")) - Number(request.searchParams.get("since")) : 0
    }).toBe(7 * 86_400_000)
    await dialog.getByRole("button", { name: "Est. cost" }).click()
    await expect(dialog.getByRole("region", { name: "Estimated API cost" })).toContainText("$0.0172")

    await dialog.getByRole("button", { name: /Quota limits/ }).click()
    await expect(dialog.getByRole("progressbar", { name: /anthropic Session/i })).toHaveAttribute("value", "25")
    await expect(dialog.getByRole("progressbar", { name: /openai weekly/i })).toHaveAttribute("value", "40")

    const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
    expect(axe.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([])

    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test("uses the full viewport on a narrow mobile surface", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await arrange(page)
    const { dialog } = await openUsage(page)
    const box = await dialog.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeGreaterThanOrEqual(380)
    expect(box!.height).toBeGreaterThanOrEqual(830)
    await expect(dialog.getByRole("button", { name: /Claxedo usage/ })).toBeVisible()
    await expect(dialog.getByRole("button", { name: /Total usage/ })).toBeVisible()
  })
})
