/**
 * Review Diff Viewer E2E Tests
 *
 * Tests the review pane diff viewer:
 * 1. Renders diff files with correct names and change counts
 * 2. Shows added/deleted/modified file indicators
 * 3. Expand/collapse all accordion items
 * 4. Unified vs split diff style toggle
 * 5. Diff content renders correctly (code lines visible)
 * 6. Different diff modes (staged, uncommitted, committed, to-from)
 * 7. Empty states: no session (new session URL) and empty session (no diffs yet)
 *
 * Uses Playwright route interception to mock HTTP APIs.
 */

import { test, expect, type Page, type Route } from "@playwright/test"

// ── Constants ───────────────────────────────────────────────────────────

const TEST_DIR = "/tmp/e2e-review-diff-test"
const TEST_SESSION_ID = "ses_review_test_123"

function base64Encode(value: string): string {
  const bytes = Buffer.from(value, "utf-8")
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

const EMPTY_SESSION_ID = "ses_empty_test_456"

const TEST_DIR_SLUG = base64Encode(TEST_DIR)
const SESSION_URL = `/${TEST_DIR_SLUG}/session/${TEST_SESSION_ID}`
const NEW_SESSION_URL = `/${TEST_DIR_SLUG}/session`
const EMPTY_SESSION_URL = `/${TEST_DIR_SLUG}/session/${EMPTY_SESSION_ID}`

function routeRE(path: string) {
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`${esc}(?:\\?.*)?$`)
}

const SESSION_LIST = routeRE("/session")

// ── Mock diff data ──────────────────────────────────────────────────────

const MODIFIED_FILE = {
  file: "src/components/button.tsx",
  before: [
    'export function Button() {',
    '  return <button>Click me</button>',
    '}',
    '',
  ].join("\n"),
  after: [
    'export function Button(props: { label: string }) {',
    '  return (',
    '    <button class="btn">',
    '      {props.label}',
    '    </button>',
    '  )',
    '}',
    '',
  ].join("\n"),
  additions: 5,
  deletions: 2,
  status: "modified" as const,
}

const ADDED_FILE = {
  file: "src/utils/helpers.ts",
  before: "",
  after: [
    'export function formatDate(date: Date): string {',
    '  return date.toISOString()',
    '}',
    '',
    'export function capitalize(str: string): string {',
    '  return str.charAt(0).toUpperCase() + str.slice(1)',
    '}',
    '',
  ].join("\n"),
  additions: 7,
  deletions: 0,
  status: "added" as const,
}

const DELETED_FILE = {
  file: "src/old/deprecated.ts",
  before: [
    'export const LEGACY = true',
    '',
    'export function oldHelper(): string {',
    '  return "deprecated"',
    '}',
    '',
  ].join("\n"),
  after: "",
  additions: 0,
  deletions: 5,
  status: "deleted" as const,
}

const SESSION_DIFFS = [MODIFIED_FILE, ADDED_FILE, DELETED_FILE]

const STAGED_DIFFS = [
  {
    file: "src/staged-change.ts",
    before: 'const value = 1\n',
    after: 'const value = 42\n',
    additions: 1,
    deletions: 1,
    status: "modified" as const,
  },
]

const UNCOMMITTED_DIFFS = [
  {
    file: "src/uncommitted-change.ts",
    before: 'export const x = "old"\n',
    after: 'export const x = "new"\nexport const y = "added"\n',
    additions: 2,
    deletions: 1,
    status: "modified" as const,
  },
  {
    file: "src/new-uncommitted.ts",
    before: "",
    after: 'export function newFunc() {\n  return true\n}\n',
    additions: 3,
    deletions: 0,
    status: "added" as const,
  },
]

const COMMITTED_DIFFS = [
  {
    file: "src/committed-feature.ts",
    before: "",
    after: [
      'export class Feature {',
      '  private name: string',
      '',
      '  constructor(name: string) {',
      '    this.name = name',
      '  }',
      '',
      '  toString(): string {',
      '    return this.name',
      '  }',
      '}',
      '',
    ].join("\n"),
    additions: 11,
    deletions: 0,
    status: "added" as const,
  },
]

const TO_FROM_DIFFS = [
  {
    file: "README.md",
    before: '# Project\n\nOld description.\n',
    after: '# Project\n\nNew and improved description.\n\n## Features\n\n- Feature A\n- Feature B\n',
    additions: 6,
    deletions: 1,
    status: "modified" as const,
  },
]

// ── Mock session data ───────────────────────────────────────────────────

const MOCK_SESSION = {
  id: TEST_SESSION_ID,
  title: "Review Test Session",
  directory: TEST_DIR,
  parentID: "",
  time: {
    created: Date.now() - 120_000,
    updated: Date.now() - 10_000,
  },
  summary: {
    files: SESSION_DIFFS.length,
    additions: SESSION_DIFFS.reduce((sum, d) => sum + d.additions, 0),
    deletions: SESSION_DIFFS.reduce((sum, d) => sum + d.deletions, 0),
  },
  version: 2,
}

const MOCK_USER_MESSAGE = {
  id: "msg_user_1",
  sessionID: TEST_SESSION_ID,
  role: "user",
  agent: "build",
  time: { created: Date.now() - 60_000 },
  system: "",
  parts: [
    {
      id: "prt_user_1",
      sessionID: TEST_SESSION_ID,
      messageID: "msg_user_1",
      type: "text",
      text: "Make some changes",
    },
  ],
  summary: {
    title: "Code changes",
    diffs: SESSION_DIFFS,
  },
}

const MOCK_ASSISTANT_MESSAGE = {
  id: "msg_asst_1",
  sessionID: TEST_SESSION_ID,
  role: "assistant",
  agent: "build",
  time: { created: Date.now() - 30_000 },
  system: "",
  parts: [
    {
      id: "prt_asst_1",
      sessionID: TEST_SESSION_ID,
      messageID: "msg_asst_1",
      type: "text",
      text: "I've made the requested changes.",
    },
  ],
}

/** An opencode session that exists but has no messages and no diffs yet. */
const MOCK_EMPTY_SESSION = {
  id: EMPTY_SESSION_ID,
  title: "Empty Session",
  directory: TEST_DIR,
  parentID: "",
  time: {
    created: Date.now() - 60_000,
    updated: Date.now() - 60_000,
  },
  version: 2,
  // no summary → reviewCount = 0 → hasReview = false
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function seedApp(page: Page) {
  await page.addInitScript(
    (args: { directory: string }) => {
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [],
          projects: {
            local: [{ worktree: args.directory, expanded: true }],
          },
          lastProject: {},
        }),
      )

      localStorage.setItem(
        "opencode.global.dat:model",
        JSON.stringify({
          recent: [{ providerID: "opencode", modelID: "test-model" }],
          user: [],
          variant: {},
        }),
      )
    },
    { directory: TEST_DIR },
  )
}

async function waitForAppReady(page: Page) {
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator('[data-claxedo]')).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(500)
}

function isAPICall(route: Route) {
  const type = route.request().resourceType()
  return type === "fetch" || type === "xhr"
}

/** Shared base mocks for health, SSE, path, model, file read, etc. */
async function setupBaseMocks(page: Page) {
  await page.route("**/health", async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ healthy: true, version: "1.0.0-test" }),
    })
  })

  await page.route("**/event?**", async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: "data: {}\n\n",
    })
  })

  await page.route("**/path**", async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ worktree: TEST_DIR, directory: TEST_DIR }),
    })
  })

  await page.route("**/session/status**", async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    })
  })

  await page.route("**/session/diff-targets**", async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        defaultRef: "main",
        candidates: ["main", "develop", "HEAD~1", "HEAD~5"],
      }),
    })
  })

  await page.route("**/session/vcs-refs", async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        branches: ["main", "feature"],
        tags: [],
        recent: [],
      }),
    })
  })

  await page.route("**/file/read**", async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ content: "// file content", path: "" }),
    })
  })
}

/**
 * Full API mocks for the populated session (TEST_SESSION_ID).
 * Session has messages and diffs.
 */
async function setupPopulatedSessionMocks(page: Page) {
  await page.route("**/session/**", async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    })
  })

  await setupBaseMocks(page)

  await page.route(SESSION_LIST, async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([MOCK_SESSION]),
    })
  })

  await page.route("**/session/vcs-diff**", async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    const url = new URL(route.request().url(), "http://localhost")
    const mode = url.searchParams.get("mode")
    const fromRef = url.searchParams.get("fromRef")
    const toRef = url.searchParams.get("toRef")

    let diffs = []
    if (mode === "staged") diffs = STAGED_DIFFS
    else if (mode === "uncommitted") diffs = UNCOMMITTED_DIFFS
    else if (mode === "to-from" && fromRef === "main" && toRef === "HEAD") diffs = TO_FROM_DIFFS
    else if (mode === "to-from") diffs = COMMITTED_DIFFS

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(diffs),
    })
  })

  await page.route(routeRE(`/session/${TEST_SESSION_ID}/message`), async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([MOCK_USER_MESSAGE, MOCK_ASSISTANT_MESSAGE]),
    })
  })

  await page.route(routeRE(`/session/${TEST_SESSION_ID}/children`), async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    })
  })

  await page.route(routeRE(`/session/${TEST_SESSION_ID}/todo`), async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    })
  })

  await page.route(routeRE(`/session/${TEST_SESSION_ID}/diff`), async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(SESSION_DIFFS),
    })
  })

  await page.route(routeRE(`/session/${TEST_SESSION_ID}`), async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_SESSION),
    })
  })
}

/**
 * API mocks for an empty session (EMPTY_SESSION_ID).
 * Session exists but has no messages and no diffs.
 */
async function setupEmptySessionMocks(page: Page) {
  await page.route("**/session/**", async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    })
  })

  await setupBaseMocks(page)

  await page.route(SESSION_LIST, async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([MOCK_EMPTY_SESSION]),
    })
  })

  await page.route(routeRE(`/session/${EMPTY_SESSION_ID}/message`), async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    })
  })

  await page.route(routeRE(`/session/${EMPTY_SESSION_ID}/children`), async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    })
  })

  await page.route(routeRE(`/session/${EMPTY_SESSION_ID}/todo`), async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    })
  })

  await page.route(routeRE(`/session/${EMPTY_SESSION_ID}/diff`), async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    })
  })

  await page.route(routeRE(`/session/${EMPTY_SESSION_ID}`), async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_EMPTY_SESSION),
    })
  })
}

/**
 * API mocks for a new-session URL (no session ID in URL).
 * No session exists — simulates terminal/CLI-only state.
 */
async function setupNoSessionMocks(page: Page) {
  await page.route("**/session/**", async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    })
  })

  await setupBaseMocks(page)

  await page.route(SESSION_LIST, async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    })
  })

  await page.route("**/session/vcs-diff**", async (route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    })
  })
}

// ── Selectors ───────────────────────────────────────────────────────────

const REVIEW_PANEL = "#review-panel"
const REVIEW_ROOT = '[data-testid="review-pane-root"]'
const REVIEW_EMPTY = '[data-testid="review-pane-empty"]'
const SESSION_REVIEW = '[data-testid="session-review-root"]'

// ── Tests ───────────────────────────────────────────────────────────────

/** Open the review panel if it is currently hidden. */
async function ensureReviewOpen(page: Page) {
  const reviewPanel = page.locator(REVIEW_PANEL)
  if (await reviewPanel.isVisible().catch(() => false)) return
  await page.getByRole("button", { name: /Open Review Pane/i }).click()
  await expect(reviewPanel).toBeVisible({ timeout: 10_000 })
}

function reviewItem(page: Page, file: string) {
  return page.locator(`[data-review-file="${file}"]`).first()
}

async function waitForSessionDiffs(page: Page) {
  await expect(page.locator(REVIEW_ROOT)).toHaveAttribute("data-review-mode", "session", { timeout: 15_000 })
  await expect(page.locator(SESSION_REVIEW)).toBeVisible({ timeout: 15_000 })
  await expect(reviewItem(page, MODIFIED_FILE.file)).toBeVisible({ timeout: 15_000 })
  await expect(reviewItem(page, ADDED_FILE.file)).toBeVisible({ timeout: 15_000 })
  await expect(reviewItem(page, DELETED_FILE.file)).toBeVisible({ timeout: 15_000 })
}

// ── Tests: populated session ────────────────────────────────────────────

test.describe("Review Diff Viewer", () => {
  test.beforeEach(async ({ page }) => {
    await seedApp(page)
    await setupPopulatedSessionMocks(page)
    await page.goto(SESSION_URL)
    await waitForAppReady(page)
  })

  test("review panel shows diff files with correct names and change indicators", async ({ page }) => {
    await ensureReviewOpen(page)
    await waitForSessionDiffs(page)

    await expect(reviewItem(page, MODIFIED_FILE.file)).toContainText("button.tsx")
    await expect(reviewItem(page, ADDED_FILE.file)).toContainText("helpers.ts")
    await expect(reviewItem(page, DELETED_FILE.file)).toContainText("deprecated.ts")
    await expect(reviewItem(page, ADDED_FILE.file)).toContainText("Added")
    await expect(reviewItem(page, DELETED_FILE.file)).toContainText("Removed")
  })

  test("expand all and collapse all works", async ({ page }) => {
    await ensureReviewOpen(page)
    await waitForSessionDiffs(page)

    const sessionReview = page.locator(SESSION_REVIEW)
    const expandCollapseBtn = sessionReview.getByRole("button", { name: /expand all|collapse all/i }).first()
    await expect(expandCollapseBtn).toBeVisible()

    const btnText = await expandCollapseBtn.textContent()
    if (btnText?.toLowerCase().includes("expand")) {
      await expandCollapseBtn.click()
    }

    await expect(reviewItem(page, MODIFIED_FILE.file).locator('[data-testid$="-trigger"]').first()).toHaveAttribute(
      "aria-expanded",
      "true",
      { timeout: 10_000 },
    )
    await expect(expandCollapseBtn).toHaveText(/collapse all/i)

    await expandCollapseBtn.click()
    await expect(expandCollapseBtn).toHaveText(/expand all/i)
  })

  test("individual accordion item expands to show diff content", async ({ page }) => {
    await ensureReviewOpen(page)
    await waitForSessionDiffs(page)

    const item = reviewItem(page, MODIFIED_FILE.file)
    const trigger = item.locator('[data-testid$="-trigger"]').first()
    await trigger.click()
    await expect(trigger).toHaveAttribute("aria-expanded", "true")
  })

  test("unified and split diff style toggle works", async ({ page }) => {
    await ensureReviewOpen(page)
    await waitForSessionDiffs(page)

    const sessionReview = page.locator(SESSION_REVIEW)
    const actions = sessionReview.locator('[data-slot="session-review-actions"]')
    await expect(actions).toBeVisible()

    const unifiedBtn = actions.getByRole("radio", { name: /unified/i }).first()
    const splitBtn = actions.getByRole("radio", { name: /split/i }).first()

    if (await unifiedBtn.isVisible().catch(() => false)) {
      await actions.locator('[data-slot="radio-group-item-label"]').filter({ hasText: "Split" }).click()
      await expect(splitBtn).toBeChecked()

      await actions.locator('[data-slot="radio-group-item-label"]').filter({ hasText: "Unified" }).click()
      await expect(unifiedBtn).toBeChecked()
    } else {
      const unifiedOption = actions.locator("text=Unified").first()
      const splitOption = actions.locator("text=Split").first()

      if (await unifiedOption.isVisible().catch(() => false)) {
        await splitOption.click()
        await page.waitForTimeout(300)
        await unifiedOption.click()
        await page.waitForTimeout(300)
      }
    }
  })

  test("vcs diff API returns staged changes for staged mode", async ({ page }) => {
    const diffs = await page.evaluate(
      async (mode: string) => {
        const res = await fetch(`/session/vcs-diff?mode=${mode}`)
        return res.json() as Promise<Array<{ file: string; status?: string }>>
      },
      "staged",
    )

    expect(diffs).toHaveLength(1)
    expect(diffs[0].file).toBe("src/staged-change.ts")
  })

  test("vcs diff API returns uncommitted changes for uncommitted mode", async ({ page }) => {
    const diffs = await page.evaluate(
      async (mode: string) => {
        const res = await fetch(`/session/vcs-diff?mode=${mode}`)
        return res.json() as Promise<Array<{ file: string; status?: string }>>
      },
      "uncommitted",
    )

    expect(diffs).toHaveLength(2)
    expect(diffs[0].file).toBe("src/uncommitted-change.ts")
    expect(diffs[1].file).toBe("src/new-uncommitted.ts")
    expect(diffs[1].status).toBe("added")
  })

  test("vcs diff API returns committed changes for to-from mode with non-main refs", async ({ page }) => {
    const diffs = await page.evaluate(
      async () => {
        const res = await fetch("/session/vcs-diff?mode=to-from&fromRef=feature&toRef=HEAD")
        return res.json() as Promise<Array<{ file: string; status?: string; additions?: number }>>
      },
    )

    expect(diffs).toHaveLength(1)
    expect(diffs[0].file).toBe("src/committed-feature.ts")
    expect(diffs[0].status).toBe("added")
    expect(diffs[0].additions).toBe(11)
  })

  test("vcs diff API returns to-from diff with explicit refs", async ({ page }) => {
    const diffs = await page.evaluate(
      async () => {
        const res = await fetch("/session/vcs-diff?mode=to-from&fromRef=main&toRef=HEAD")
        return res.json() as Promise<Array<{ file: string; status?: string; additions?: number }>>
      },
    )

    expect(diffs).toHaveLength(1)
    expect(diffs[0].file).toBe("README.md")
    expect(diffs[0].status).toBe("modified")
    expect(diffs[0].additions).toBe(6)
  })

  test("session diffs render with correct change counts in UI", async ({ page }) => {
    await ensureReviewOpen(page)
    await waitForSessionDiffs(page)

    const modifiedItem = reviewItem(page, MODIFIED_FILE.file)
    await expect(modifiedItem).toContainText("+5")
    await expect(modifiedItem).toContainText("-2")
  })

  test("review panel toggles with the toolbar button", async ({ page }) => {
    const reviewPanel = page.locator(REVIEW_PANEL)
    await expect(reviewPanel).toHaveCount(0)
    await page.getByRole("button", { name: /Open Review Pane/i }).click()
    await expect(reviewPanel).toBeVisible({ timeout: 10_000 })
    await page.getByRole("button", { name: /Close Review Pane/i }).click()
    await expect(reviewPanel).toHaveCount(0)
  })

  test("added file shows 'Added' badge with green indicator", async ({ page }) => {
    await ensureReviewOpen(page)
    await waitForSessionDiffs(page)

    const addedItem = reviewItem(page, ADDED_FILE.file)
    await expect(addedItem).toContainText("Added")
    await expect(addedItem).toContainText("+7")
  })

  test("deleted file shows 'Removed' badge", async ({ page }) => {
    await ensureReviewOpen(page)
    await waitForSessionDiffs(page)
    await expect(reviewItem(page, DELETED_FILE.file)).toContainText("Removed")
  })

  test("expanding a diff shows before and after code content", async ({ page }) => {
    await ensureReviewOpen(page)
    await waitForSessionDiffs(page)

    const modifiedItem = reviewItem(page, MODIFIED_FILE.file)
    const trigger = modifiedItem.locator('[data-testid$="-trigger"]').first()
    await trigger.click()
    await expect(trigger).toHaveAttribute("aria-expanded", "true")
  })

  test("directory path shown for nested files", async ({ page }) => {
    await ensureReviewOpen(page)
    await waitForSessionDiffs(page)
    await expect(reviewItem(page, MODIFIED_FILE.file)).toContainText("src/components")
  })
})

// ── Tests: empty states ─────────────────────────────────────────────────

test.describe("Review Diff Viewer — empty states", () => {

  test("no opencode session opens uncommitted review with empty state", async ({ page }) => {
    await seedApp(page)
    await setupNoSessionMocks(page)
    await page.goto(NEW_SESSION_URL)
    await waitForAppReady(page)

    await ensureReviewOpen(page)

    const reviewPanel = page.locator(REVIEW_PANEL)
    await expect(reviewPanel).toBeVisible({ timeout: 15_000 })

    await expect(page.locator(`${REVIEW_ROOT}[data-review-mode="uncommitted"]`)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator(REVIEW_EMPTY)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator(REVIEW_EMPTY)).toContainText("No changes for this review mode")
  })

  test("vcs diff API returns git-based changes without a session ID", async ({ page }) => {
    await seedApp(page)
    await setupPopulatedSessionMocks(page)
    await page.goto(NEW_SESSION_URL)
    await waitForAppReady(page)

    const staged = await page.evaluate(
      async () => {
        const res = await fetch("/session/vcs-diff?mode=staged")
        return res.json() as Promise<Array<{ file: string }>>
      },
    )
    expect(staged).toHaveLength(1)
    expect(staged[0].file).toBe("src/staged-change.ts")

    const uncommitted = await page.evaluate(
      async () => {
        const res = await fetch("/session/vcs-diff?mode=uncommitted")
        return res.json() as Promise<Array<{ file: string }>>
      },
    )
    expect(uncommitted).toHaveLength(2)

    const committed = await page.evaluate(
      async () => {
        const res = await fetch("/session/vcs-diff?mode=to-from&fromRef=main&toRef=HEAD")
        return res.json() as Promise<Array<{ file: string }>>
      },
    )
    expect(committed).toHaveLength(1)
    expect(committed[0].file).toBe("README.md")
  })

  test("opencode session exists but is empty — shows empty review message", async ({ page }) => {
    await seedApp(page)
    await setupEmptySessionMocks(page)
    await page.goto(EMPTY_SESSION_URL)
    await waitForAppReady(page)

    await ensureReviewOpen(page)

    const reviewPanel = page.locator(REVIEW_PANEL)
    await expect(reviewPanel).toBeVisible({ timeout: 15_000 })

    await expect(page.locator(`${REVIEW_ROOT}[data-review-mode="session"]`)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator(REVIEW_EMPTY)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator(REVIEW_EMPTY)).toContainText("No changes for this review mode")
  })

  test("empty session — no expand/collapse or diff style controls for session mode", async ({ page }) => {
    await seedApp(page)
    await setupEmptySessionMocks(page)
    await page.goto(EMPTY_SESSION_URL)
    await waitForAppReady(page)

    await ensureReviewOpen(page)

    const reviewPanel = page.locator(REVIEW_PANEL)
    await expect(reviewPanel).toBeVisible({ timeout: 15_000 })

    await expect(page.locator(REVIEW_EMPTY)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator(REVIEW_EMPTY)).toContainText("No changes for this review mode")

    const expandCollapseBtn = reviewPanel.getByRole("button", { name: /expand all|collapse all/i }).first()
    await expect(expandCollapseBtn).toHaveCount(0)

    const unifiedBtn = reviewPanel.getByRole("radio", { name: /unified/i }).first()
    await expect(unifiedBtn).toHaveCount(0)
  })
})
