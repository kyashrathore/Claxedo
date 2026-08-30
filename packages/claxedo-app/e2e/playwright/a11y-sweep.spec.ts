/**
 * SPEC: Accessibility (axe-core) sweep across the highest-traffic surfaces
 *
 * PURPOSE — per the a11y audit (health 4/10, test spec-grade 2/10): "There is zero
 * automated accessibility testing
 * (no axe-core/jest-axe anywhere, only one Escape-key assertion across 28 Playwright
 * specs), so nothing currently prevents regressions as many external contributors touch
 * this code." This spec is that first automated net: it runs axe-core
 * (`@axe-core/playwright`) over the app's five highest-traffic surfaces and fails on any
 * NEW violation rule that isn't already tracked in the shrink-only baseline
 * (`a11y-baseline.json`). It does not attempt to fix any of the app's real,
 * already-documented a11y gaps (prompt-input popover ARIA, terminal screen-reader
 * support, keyboard-only resize, etc.); it only prevents the currently-known violation set from growing, and forces
 * the baseline itself to shrink the moment a tracked violation is actually fixed.
 *
 * STATE MODEL — `a11y-baseline.json` maps each surface name below to the sorted, unique
 * list of axe violation rule `id`s currently present on that surface (seeded directly
 * from a real run against this tree — see the "Refactor steps" entry this spec
 * implements: "Add @axe-core/playwright as a devDependency, and inject an axe scan into
 * 3-4 of the highest-traffic existing e2e specs... asserting zero critical/serious
 * violations"; this spec generalizes that to a shrink-only baseline covering ALL
 * violations, not just critical/serious, since even a "minor" tracked violation must not
 * silently gain a sibling). The comparison is symmetric-difference, not a max-count
 * ratchet (matching `src/architecture/debt-ratchet.test.ts`'s exact-pin style, but
 * keyed by rule id instead of a raw count): any rule id axe reports on a surface that
 * ISN'T already in that surface's baseline array is a new regression and fails the test;
 * any rule id still listed in the baseline that axe no longer reports on that surface is
 * stale debt that must be pruned from `a11y-baseline.json` before the test can pass
 * again — this is what keeps the baseline honest (it can shrink as violations get fixed,
 * it can never silently grow).
 *
 * ANATOMY — five surfaces, one `test()` each:
 *   1. `home` — `/` with zero projects registered (the real reachable empty state per
 *      `core-boot-deep-links-home.spec.ts`'s ANATOMY finding — `pages/home.tsx` itself
 *      is permanently `display:none` and unreachable, so this scans the actual
 *      `RailWorkbenchCanvas` empty-state fallback a user sees).
 *   2. `session-page` — a real, settled session pane after one oracle-proven turn
 *      (`[data-testid="session-content"]`), the single most-visited surface in the app.
 *   3. `settings-dialog` — `DialogSettings` open on top of the session page (opened the
 *      same way `core-settings-auth.spec.ts` does — the sidebar "Settings" button).
 *   4. `command-palette` — the command palette (`[data-testid="command-palette"]`) open
 *      on top of the session page, opened the same way
 *      `core-panes-split-tabs.spec.ts`'s behavior-17 test does (mod+shift+P).
 *   5. `prompt-input-focused` — the session page with the composer's contenteditable
 *      `role="textbox"` actually focused (not just present), since the a11y appendix's
 *      top "[critical]" finding is specifically about this widget's popover ARIA once a
 *      user is typing.
 *
 * BEHAVIORS —
 *   1. Each surface's axe violation rule-id set exactly equals its `a11y-baseline.json`
 *      entry — no new rule ids, no stale/already-fixed rule ids left behind.
 *
 * INVARIANTS — none beyond the shared oracle/turn-settling invariants in
 *   `e2e/INVARIANTS.md`, reused unchanged for the `session-page`/`settings-dialog`/
 *   `command-palette`/`prompt-input-focused` surfaces' underlying turn.
 *
 * HARNESS NOTES — every scenario uses the default `opencode` harness from
 *   `installMockRuntime`; harness selection itself is out of scope.
 *
 * OUT OF SCOPE — fixing any individual violation (tracked separately per the appendix's
 *   own refactor steps); a11y at the mobile viewport (`mobile-smoke.spec.ts` covers
 *   viewport-narrow behavior, not accessibility scanning); keyboard-operability/focus-
 *   trap behavioral tests beyond what axe's static analysis catches (those need
 *   dedicated interaction tests per the appendix's "Tests" gaps list, not this spec).
 */
import { expect, test, type Page } from "@playwright/test"
import { AxeBuilder } from "@axe-core/playwright"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { installMockRuntime } from "../helpers/mock-runtime"
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
    ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string } }).__OPENCODE__ = {
      serverUrl: window.location.origin,
    }
  })
}

async function seedOneProject(page: Page, dir: string) {
  await page.addInitScript((d: string) => {
    localStorage.clear()
    ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
      serverUrl: window.location.origin,
      activeDirectory: d,
    }
    localStorage.setItem(
      "opencode.global.dat:server",
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
  const dialog = page.locator('[data-slot="dialog-container"]').last()
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  return dialog
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
  const expected = baseline[surface] ?? []
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

// `@core`, not `@happy`: this is a Tier M spec (every route mocked via
// `installMockRuntime`, zero real network — e2e/INVARIANTS.md rule 6) and its whole
// purpose is to be a CI regression net. It was tagged `@happy`, a dead
// pre-consolidation lane that no npm script and no CI job selects, so the sweep never
// once ran in the lane it was written to guard. See the suite lane registry in
// `playwright.config.ts`.
test.describe("a11y sweep @core", () => {
  test("home (zero-project empty state) has no new axe violations — behavior 1", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await mockEmptyBootstrap(page)
    await seedNoProjects(page)
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("No projects yet. Create one to get started.")).toBeVisible({ timeout: 20_000 })

    await assertMatchesBaseline(page, "home")
  })

  test("session page (settled turn) has no new axe violations — behavior 1", async ({ page }) => {
    await settleOneTurn(page, DIR)
    await assertMatchesBaseline(page, "session-page")
  })

  test("settings dialog (open) has no new axe violations — behavior 1", async ({ page }) => {
    await settleOneTurn(page, DIR)
    await openSettings(page)
    await assertMatchesBaseline(page, "settings-dialog")
  })

  test("command palette (open) has no new axe violations — behavior 1", async ({ page }) => {
    await settleOneTurn(page, DIR)
    await openCommandPalette(page)
    await assertMatchesBaseline(page, "command-palette")
  })

  test("prompt input (focused) has no new axe violations — behavior 1", async ({ page }) => {
    await settleOneTurn(page, DIR)
    const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await input.click()
    await expect(input).toBeFocused()

    await assertMatchesBaseline(page, "prompt-input-focused")
  })
})
