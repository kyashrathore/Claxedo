/** Real axe scans of five mounted surfaces, with a shrinking set of known rule IDs.
 * This rule-level baseline cannot detect additional nodes failing an already tracked rule.
 */
import { expect, test, type Page } from "@playwright/test"
import { AxeBuilder } from "@axe-core/playwright"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { bootstrapDeployment, installMockRuntime } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, ensureComposerModelSelected, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-a11y-sweep"
const SESSION_ID = "ses_a11y_sweep"

// `import.meta.dirname` would be simpler, but this repo's e2e tsconfig targets a
// `module`/`moduleResolution` pair where that field isn't declared on `ImportMeta` —
// `fileURLToPath(import.meta.url)` is the portable ESM equivalent of `__dirname`
// (unavailable here: `package.json` is `"type": "module"`).
const BASELINE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "a11y-baseline.json")
type Baseline = Record<string, string[]>
const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function seedNoProjects(page: Page) {
  await page.addInitScript(() => {
    localStorage.clear()
    // Same-origin fix as core-boot-deep-links-home.spec.ts's seedNoProjects: without
    // this, server URL resolution falls through to the hardcoded cross-origin default
    // (127.0.0.1:3001) and the resulting fetch fails as a cross-origin CORS preflight.
    ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string } }).__CLAXEDO__ = {
      serverUrl: window.location.origin,
    }
  })
}

async function seedOneProject(page: Page, dir: string) {
  await page.addInitScript((d: string) => {
    localStorage.clear()
    ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
      serverUrl: window.location.origin,
      activeDirectory: d,
    }
    localStorage.setItem(
      "claxedo.global.dat:server",
      JSON.stringify({
        list: [],
        projects: { local: [{ worktree: d, expanded: true }] },
        lastProject: {},
        workspaceServer: {},
        closedProjects: {},
      }),
    )
  }, dir)
}

async function mockEmptyBootstrap(page: Page) {
  await page.route("**/api/claxedo/bootstrap**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        healthy: true,
        events: { hostAggregate: true },
        deployment: bootstrapDeployment(),
        version: "1.0.0-test",
        path: { state: "", config: "", worktree: "", directory: "", home: "/tmp" },
        project: [],
        provider: { all: [], default: {}, connected: [] },
        provider_auth: {},
        config: {},
      }),
    }),
  )
  await page.route("**/project**", (route) => {
    const type = route.request().resourceType()
    if (type !== "fetch" && type !== "xhr") return route.continue()
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  })
}

async function openWorkbench(page: Page, dir: string) {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  if (!(await page.getByRole("textbox", { name: /Ask anything/i }).isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "New Session" }).first().click()
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 10_000 })
  }
}

/** Drives one real, oracle-proven turn — same shape as
 * core-boot-deep-links-home.spec.ts's createSessionViaFirstSend, trimmed to what this
 * spec needs (no URL-shape assertions). */
async function settleOneTurn(page: Page, dir: string) {
  await installMockRuntime(page, { dir, sessionId: SESSION_ID })
  await seedOneProject(page, dir)
  await openWorkbench(page, dir)
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await ensureComposerModelSelected(page)
  await input.click()
  await input.fill("a11y sweep seed turn")
  await expect(input).toContainText("a11y sweep seed turn", { timeout: 10_000 })
  await page.locator(SELECTORS.submitControl).last().click()
  await expectAssistantReplyVisible(page, "ack 1: a11y sweep seed turn", {
    spec: "a11y-sweep",
    scenario: "seed-turn",
  })
}

async function modKey(page: Page): Promise<"Meta" | "Control"> {
  const isMac = await page.evaluate(() => /(Mac|iPod|iPhone|iPad)/.test(navigator.platform))
  return isMac ? "Meta" : "Control"
}

async function openSettings(page: Page) {
  await page.getByTestId("rail-account-trigger").click()
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
  const surface = page.locator('[data-component="settings-content"]')
  await expect(surface).toBeVisible({ timeout: 10_000 })
  return surface
}

async function openCommandPalette(page: Page) {
  await page.keyboard.press(`${await modKey(page)}+Shift+P`)
  const palette = page.locator('[data-testid="command-palette"]')
  await expect(palette).toBeVisible({ timeout: 10_000 })
  return palette
}

type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>

function describeNew(ids: string[], results: AxeResults) {
  return ids
    .map((id) => {
      const violation = results.violations.find((entry) => entry.id === id)
      // The offending NODES, not just the rule id: a rule name alone sends the
      // next person hunting through a whole page snapshot for the one element
      // that broke, which is the slowest part of acting on this failure.
      const nodes = (violation?.nodes ?? [])
        .map((node) => `\n      • ${node.target.join(" ")} — ${node.html.slice(0, 160)}`)
        .join("")
      return `  - ${id} (${violation?.impact ?? "unknown"}): ${violation?.description ?? ""} [${violation?.nodes.length ?? 0} node(s)] — ${violation?.helpUrl ?? ""}${nodes}`
    })
    .join("\n")
}

/** Runs axe on the current page and asserts its violation rule-id set exactly equals
 * `a11y-baseline.json[surface]` (this spec ratchets on RULE ids, not raw violation-node
 * counts, matching the debt-ratchet suite's "named rule" style — see this file's SPEC
 * STATE MODEL). */
async function assertMatchesBaseline(page: Page, surface: string) {
  const results = await new AxeBuilder({ page }).analyze()
  const current = [...new Set(results.violations.map((violation) => violation.id))].sort()
  expect(baseline, `missing accessibility baseline for ${surface}`).toHaveProperty(surface)
  const expected = baseline[surface]
  const newIds = current.filter((id) => !expected.includes(id))
  const staleIds = expected.filter((id) => !current.includes(id))

  expect(
    newIds,
    newIds.length
      ? `NEW a11y violation(s) on "${surface}" not in a11y-baseline.json — fix them or ` +
          `(only if genuinely accepted as tracked debt) add their rule id(s) to ` +
          `baseline["${surface}"]:\n${describeNew(newIds, results)}`
      : undefined,
  ).toEqual([])

  expect(
    staleIds,
    staleIds.length
      ? `a11y-baseline.json["${surface}"] lists rule id(s) that axe no longer reports — ` +
          `these are fixed; prune them from the baseline: ${staleIds.join(", ")}`
      : undefined,
  ).toEqual([])
}

// `@core`, not `@happy`: every route is mocked through `installMockRuntime` with no
// real network, so this is a Tier M spec, and `@core` is the lane CI selects.
// `playwright.config.ts` holds the lane registry; a tag outside it runs nothing, silently.
test.describe("a11y sweep @core", () => {
  test("home (zero-project empty state) has no new axe violations", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await mockEmptyBootstrap(page)
    await seedNoProjects(page)
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    // With no project, the workbench opens on the first project's form.
    await expect(page.getByRole("heading", { name: "Start with a project", level: 1 })).toBeVisible({ timeout: 20_000 })

    await assertMatchesBaseline(page, "home")
  })

  test("session page (settled turn) has no new axe violations", async ({ page }) => {
    await settleOneTurn(page, DIR)
    await assertMatchesBaseline(page, "session-page")
  })

  test("settings surface (open) has no new axe violations", async ({ page }) => {
    await settleOneTurn(page, DIR)
    await openSettings(page)
    await assertMatchesBaseline(page, "settings-surface")
  })

  test("command palette (open) has no new axe violations", async ({ page }) => {
    await settleOneTurn(page, DIR)
    await openCommandPalette(page)
    await assertMatchesBaseline(page, "command-palette")
  })

  test("prompt input (focused) has no new axe violations", async ({ page }) => {
    await settleOneTurn(page, DIR)
    const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await input.click()
    await expect(input).toBeFocused()

    await assertMatchesBaseline(page, "prompt-input-focused")
  })
})
