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
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        list: [],
        projects: { local: [{ worktree: dir, expanded: true }] },
        lastProject: {},
        workspaceServer: {},
        closedProjects: {},
      }),
    )
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
  daily: [{ date: "2026-08-09", estimatedUsd, pricedTokens: 2_350, unpricedTokens: 0 }],
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
      locationShare: { localTokens: 1_350, cloudTokens: 1_000 },
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
    chart: {
      dimension: group,
      series: [
        {
          value: group === "model" ? "openai/gpt-5" : "openai",
          label: group === "model" ? "gpt-5" : "openai",
          daily: [{ date: "2026-08-09", input: 1_000, output: 1_000, reasoning: 100, cacheRead: 200, cacheWrite: 50 }],
        },
        {
          value: group === "model" ? "anthropic/claude-sonnet" : "anthropic",
          label: group === "model" ? "claude-sonnet" : "anthropic",
          daily: [{ date: "2026-08-09", input: 200, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0 }],
        },
      ],
    },
    filterOptions: {
      claxedo: { harness: ["codex-app-server", "claude-sdk"], model: ["openai/gpt-5"], location: ["local", "cloud"] },
      total: {
        app: ["Claxedo", "claude"],
        model: ["openai/gpt-5", "claude/claude-sonnet"],
        location: ["local", "cloud"],
      },
    },
    sync: { attempted: 1, delivered: 1, conflicts: 0, pending: 0 },
    breakdown: {
      dimension: group,
      rows: [
        {
          value: group === "provider" ? "openai" : group === "model" ? "openai/gpt-5" : "codex-app-server",
          label: group === "provider" ? "openai" : group === "model" ? "gpt-5" : "codex-app-server",
          turnCount: 8,
          input: 1_000,
          output: 1_000,
          reasoning: 100,
          cacheRead: 200,
          cacheWrite: 50,
          unknownCategories: 0,
          estimatedUsd: 0.0142,
          pricedTokens: 2_350,
          unpricedTokens: 0,
          status: "final",
        },
        {
          value: group === "provider" ? "anthropic" : group === "model" ? "anthropic/claude-sonnet" : "claude-sdk",
          label: group === "provider" ? "anthropic" : group === "model" ? "claude-sonnet" : "claude-sdk",
          turnCount: 2,
          input: 200,
          output: 100,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          unknownCategories: 0,
          estimatedUsd: 0.003,
          pricedTokens: 300,
          unpricedTokens: 0,
          status: "final",
        },
      ],
      ...(url.searchParams.get("after") || group === "model"
        ? {}
        : { next: group === "provider" ? "anthropic" : "claude-sdk" }),
    },
    modelBreakdown: {
      dimension: "model",
      rows: [
        {
          value: "openai/gpt-5",
          label: "gpt-5",
          turnCount: 8,
          input: 1_000,
          output: 1_000,
          reasoning: 100,
          cacheRead: 200,
          cacheWrite: 50,
          unknownCategories: 0,
          estimatedUsd: 0.0142,
          pricedTokens: 2_350,
          unpricedTokens: 0,
          status: "final",
        },
        {
          value: "anthropic/claude-sonnet",
          label: "claude-sonnet",
          turnCount: 2,
          input: 200,
          output: 100,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          unknownCategories: 0,
          estimatedUsd: 0.003,
          pricedTokens: 300,
          unpricedTokens: 0,
          status: "final",
        },
      ],
      ...(url.searchParams.get("model_after") ? {} : { next: "anthropic/claude-sonnet" }),
    },
  }
}

async function arrange(page: Page) {
  await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
  const requests: URL[] = []
  await page.route("**/api/claxedo/usage**", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/sync")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ attempted: 0, delivered: 0, conflicts: 0, pending: 0 }),
      })
      return
    }
    const view = url.searchParams.get("view")
    if (view !== "quota" && view !== "claxedo" && view !== "total") {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "missing usage view" }),
      })
      return
    }
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

    await expect(dialog.getByRole("button", { name: "Usage through Claxedo" })).toHaveAttribute("aria-pressed", "true")
    await expect(dialog.getByRole("button", { name: "Usage through Claxedo" })).toHaveText("Usage through Claxedo")
    await expect(dialog.getByRole("button", { name: "Total local usage" })).toHaveText("Total local usage")
    await expect(dialog.getByRole("button", { name: "30 days" })).toHaveAttribute("aria-pressed", "true")
    await expect(dialog.getByRole("button", { name: "Tokens" })).toHaveAttribute("aria-pressed", "true")
    await expect(dialog.getByRole("table", { name: "Usage grouped by provider" })).toContainText("Codex")
    await expect(dialog.getByRole("table", { name: "Usage grouped by provider" })).not.toContainText("Claxedo")
    await expect(dialog).toContainText("1 local events counted in Total without Claxedo ownership attribution")
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((request) => request.searchParams.get("view") === "claxedo")).toBe(true)

    await dialog.getByRole("button", { name: "Total local usage" }).click()
    await expect.poll(() => requests.some((request) => request.searchParams.get("view") === "total")).toBe(true)
    await expect(dialog.getByRole("button", { name: "Total local usage" })).toHaveAttribute("aria-pressed", "true")
    await expect(dialog.getByRole("table", { name: "Usage grouped by provider" })).toContainText("Claude")
    await expect(dialog.getByRole("table", { name: "Usage grouped by provider" })).not.toContainText("Claxedo")
    await expect(dialog.getByRole("table", { name: "Usage grouped by model" })).toHaveCount(0)
    await dialog.locator(".usage-chart-plot").focus()
    const tooltip = dialog.getByRole("status")
    await expect(tooltip).toContainText("Aug 9, 2026")
    await expect(tooltip).toContainText("Codex")
    await expect(tooltip).toContainText("Claude")
    await expect(tooltip).toContainText("Total")
    await expect
      .poll(() => new Set(requests.map((request) => request.searchParams.get("group"))).has("provider"))
      .toBe(true)
    expect(requests.some((request) => request.searchParams.get("group") === "model")).toBe(false)
    await expect(dialog.getByLabel(/Filter by/)).toHaveCount(0)
    await expect(dialog).not.toContainText("Local ·")
    await dialog.getByRole("button", { name: "Model", exact: true }).click()
    await expect(dialog.getByRole("table", { name: "Usage grouped by model" })).toContainText("gpt-5")
    await expect(dialog.getByRole("table", { name: "Usage grouped by provider" })).toHaveCount(0)
    await dialog.getByRole("button", { name: "Next breakdown page" }).click()
    await expect
      .poll(() => requests.some((request) => request.searchParams.get("model_after") === "anthropic/claude-sonnet"))
      .toBe(true)
    await dialog.getByRole("button", { name: "Previous breakdown page" }).click()
    await dialog.getByRole("button", { name: "Provider", exact: true }).click()
    await dialog.getByRole("button", { name: "Next breakdown page" }).click()
    await expect
      .poll(() =>
        requests.some(
          (request) =>
            request.searchParams.get("group") === "provider" && request.searchParams.get("after") === "anthropic",
        ),
      )
      .toBe(true)
    await dialog.getByRole("button", { name: "Previous breakdown page" }).click()
    await dialog.getByRole("button", { name: "7 days" }).click()
    await expect
      .poll(() => {
        const request = requests.findLast(
          (candidate) =>
            Number(candidate.searchParams.get("until")) - Number(candidate.searchParams.get("since")) ===
            7 * 86_400_000 - 1,
        )
        return request ? Number(request.searchParams.get("until")) - Number(request.searchParams.get("since")) : 0
      })
      .toBe(7 * 86_400_000 - 1)
    await dialog.getByRole("button", { name: "Cost" }).click()
    await expect(dialog.getByLabel("Estimated raw token cost")).toContainText("$0.02")
    await expect(dialog.getByRole("img", { name: /^Daily estimated API cost\./ })).toBeVisible()

    await dialog.getByRole("button", { name: "Usage limits" }).click()
    await expect.poll(() => requests.some((request) => request.searchParams.get("view") === "quota")).toBe(true)
    await expect(dialog.getByRole("progressbar", { name: /anthropic Session/i })).toHaveAttribute("value", "25")
    await expect(dialog.getByRole("progressbar", { name: /openai weekly/i })).toHaveAttribute("value", "40")
    await expect(dialog.getByRole("button", { name: "Usage through Claxedo" })).toBeVisible()
    await dialog.getByRole("button", { name: "Usage through Claxedo" }).click()
    await expect(dialog.getByRole("button", { name: "Usage through Claxedo" })).toHaveAttribute("aria-pressed", "true")

    const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
    expect(
      axe.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious"),
    ).toEqual([])

    // Axe may move the document's active element while it inspects the modal.
    // Target the open dialog so this still exercises the real keyboard close
    // path instead of depending on the audit library's focus side effects.
    await dialog.press("Escape")
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
    await expect(dialog.getByRole("button", { name: "Usage through Claxedo" })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Total local usage" })).toBeVisible()
  })
})
