import { expect, type Locator, type Page } from "@playwright/test"
import { captureEvidence, type Evidence } from "./visual-evidence"

// Capture ALWAYS precedes the assertion it documents, never follows it. This inverts
// `turn-oracle.ts`'s existing order (there, `captureEvidence` is the LAST step, after
// `domTruth`/`thinkingRowGone`/`submitControlReady`/`geometricTruth` have all already
// thrown-or-passed) — deliberately, not by oversight. If a screenshot is the last thing a
// function does, a function that throws on its second of five assertions never captures
// anything at all, and the reviewer investigating exactly that failure has no evidence to
// look at — the one situation `e2e/INVARIANTS.md` rule #2 exists to prevent. Capturing
// first means the PNG exists whichever way the very next assertion resolves; the pixels
// simply show whatever was true when the claim was made, pass or fail alike.
function withSuffix(evidence: Evidence | undefined, suffix: string): Evidence | undefined {
  return evidence ? { spec: evidence.spec, scenario: `${evidence.scenario}-${suffix}` } : undefined
}

export const SELECTORS = {
  sessionRow: (sessionId: string) => `[data-testid="rail-sidebar-session-row"][data-session-id="${sessionId}"]`,
  allSessionRows: '[data-testid="rail-sidebar-session-row"]',
  terminalRow: (terminalId: string) => `[data-testid="rail-sidebar-terminal-row"][data-terminal-id="${terminalId}"]`,
  title: '[data-slot="session-navigation-title"]',
  time: '[data-slot="session-navigation-time"]',
  statusDot: '[data-sidebar-status]',
  glyph: '[data-slot="navigation-row-glyph"]',
} as const

const DEFAULT_TIMEOUT = 15_000

export async function readRailSessionOrder(page: Page): Promise<string[]> {
  return page.locator(SELECTORS.allSessionRows).evaluateAll(rows => rows
    .filter(row => row.getBoundingClientRect().height > 0)
    .map(row => row.getAttribute("data-session-id")!)
  )
}

const PLACEHOLDER_TITLE = /^(New Session|Untitled session)$/

export async function expectTerminalRailStatus(opts: {
  page: Page
  terminalId: string
  status: "working" | "permission" | "done"
  timeout?: number
}) {
  const row = opts.page.locator(SELECTORS.terminalRow(opts.terminalId))
  await expect(row).toBeVisible({ timeout: opts.timeout ?? DEFAULT_TIMEOUT })
  await expect(row.locator(SELECTORS.statusDot)).toHaveAttribute("data-sidebar-status", opts.status, {
    timeout: opts.timeout ?? DEFAULT_TIMEOUT,
  })
  await expect(row.locator(SELECTORS.statusDot)).toBeVisible()
}

export async function expectTerminalRailStatusAbsent(opts: { page: Page; terminalId: string }) {
  const row = opts.page.locator(SELECTORS.terminalRow(opts.terminalId))
  await expect(row).toBeVisible()
  await expect(row.locator(SELECTORS.statusDot), "Cancelled terminal work must not leave a done badge").toHaveCount(0)
}

/**
 * The row for `sessionId` is visible without a reload and, when `index` is given, sits at
 * that position among session rows. A duplicate row fails strict mode here (see
 * `expectRailRowUnique`).
 */
export async function expectRailRowVisible(opts: {
  page: Page
  sessionId: string
  index?: number
  timeout?: number
  evidence?: Evidence
}): Promise<Locator> {
  const { page, sessionId, index, timeout = DEFAULT_TIMEOUT, evidence } = opts
  const row = page.locator(SELECTORS.sessionRow(sessionId))

  if (evidence) await captureEvidence({ page, spec: evidence.spec, scenario: evidence.scenario })

  await expect(
    row,
    `rail row for session "${sessionId}" never became visible without a reload`,
  ).toBeVisible({ timeout })

  if (index !== undefined) {
    await expect(
      page.locator(SELECTORS.allSessionRows).nth(index),
      `session "${sessionId}" was expected at rail index ${index}, but a different row occupies it`,
    ).toHaveAttribute("data-session-id", sessionId, { timeout })
  }

  return row
}

export async function expectRailStatusAbsent(opts: {
  page: Page
  sessionId: string
  timeout?: number
}): Promise<void> {
  const { page, sessionId, timeout = DEFAULT_TIMEOUT } = opts
  const row = page.locator(SELECTORS.sessionRow(sessionId))
  await expect(row, `rail row for session "${sessionId}" is not visible`).toBeVisible({ timeout })
  await expect(
    row.locator(SELECTORS.statusDot),
    `settled rail row for session "${sessionId}" retained a stale lifecycle dot`,
  ).toHaveCount(0, { timeout })
}

/**
 * The rail title leaves the create-time placeholder ("New Session" / "Untitled session")
 * without a reload; returns the settled text.
 *
 * Polled by hand rather than `expect(title).not.toHaveText(PLACEHOLDER_TITLE)`: an empty
 * title also fails that regex, so the naive form resolves the instant the row mounts with
 * no text. Non-empty, non-placeholder text is required.
 */
export async function expectRailTitleSettled(opts: {
  page: Page
  sessionId: string
  timeout?: number
  evidence?: Evidence
}): Promise<string> {
  const { page, sessionId, timeout = DEFAULT_TIMEOUT, evidence } = opts
  const row = page.locator(SELECTORS.sessionRow(sessionId))
  await expect(row, `rail row for session "${sessionId}" is not visible`).toBeVisible({ timeout })
  const title = row.locator(SELECTORS.title)

  const deadline = Date.now() + timeout
  for (;;) {
    const text = (await title.textContent().catch(() => null))?.trim() ?? ""
    if (text.length > 0 && !PLACEHOLDER_TITLE.test(text)) {
      if (evidence) await captureEvidence({ page, spec: evidence.spec, scenario: evidence.scenario })
      return text
    }
    if (Date.now() > deadline) {
      if (evidence) await captureEvidence({ page, spec: evidence.spec, scenario: evidence.scenario })
      expect(text.length, `rail title for session "${sessionId}" never rendered any text within ${timeout}ms`).toBeGreaterThan(0)
      expect(
        text,
        `rail title for session "${sessionId}" is still the create-time placeholder "${text}" after ${timeout}ms`,
      ).not.toMatch(PLACEHOLDER_TITLE)
      return text // unreachable: one of the two expects above always throws first
    }
    await page.waitForTimeout(250)
  }
}

/**
 * After a re-prompt, the row for `sessionId` is at rail index 0. Asserted on whichever
 * row is first so a failure names the row that outranks it.
 */
export async function expectRailRowMovesToTop(opts: {
  page: Page
  sessionId: string
  timeout?: number
  evidence?: Evidence
}): Promise<void> {
  const { page, sessionId, timeout = DEFAULT_TIMEOUT, evidence } = opts
  if (evidence) await captureEvidence({ page, spec: evidence.spec, scenario: evidence.scenario })
  await expect(
    page.locator(SELECTORS.allSessionRows).first(),
    `expected session "${sessionId}" at rail index 0 after being re-prompted, but a different row still outranks it`,
  ).toHaveAttribute("data-session-id", sessionId, { timeout })
}

/**
 * Exactly one row renders for `sessionId`. A `session.lifecycle` frame carrying
 * `info.workspaceID` once rendered the same session under both a project section and a
 * workspace section; this makes that a failure instead of something `.first()` hides.
 */
export async function expectRailRowUnique(opts: {
  page: Page
  sessionId: string
  timeout?: number
  evidence?: Evidence
}): Promise<void> {
  const { page, sessionId, timeout = DEFAULT_TIMEOUT, evidence } = opts
  if (evidence) await captureEvidence({ page, spec: evidence.spec, scenario: evidence.scenario })
  await expect(
    page.locator(SELECTORS.sessionRow(sessionId)),
    `expected exactly one rail row for session "${sessionId}"`,
  ).toHaveCount(1, { timeout })
}

/**
 * The status dot on a row that is never focused transitions working -> done, sits inside
 * the glyph column left of the title, and leaves the timestamp rendered.
 *
 * The row must be visible and idle (no dot) before `driveWorking` runs, and that is
 * asserted here rather than trusted: a Solid component body runs once, so a glyph that
 * reads its status only at mount looks correct to any test that mounts the row already
 * "working".
 *
 * `driveWorking`/`driveDone` are the caller's transport (SSE mock or a real lane); this
 * module owns assertions, not delivery.
 */
export async function expectRailStatus(opts: {
  page: Page
  sessionId: string
  driveWorking: () => Promise<void> | void
  driveDone: () => Promise<void> | void
  timeout?: number
  evidence?: Evidence
}): Promise<Locator> {
  const { page, sessionId, driveWorking, driveDone, timeout = DEFAULT_TIMEOUT, evidence } = opts
  const row = page.locator(SELECTORS.sessionRow(sessionId))
  await expect(row, `rail row for session "${sessionId}" is not visible`).toBeVisible({ timeout })

  await expect(
    row.locator(SELECTORS.statusDot),
    `rail row for session "${sessionId}" already carries a status dot before this oracle drove one; the row must mount idle`,
  ).toHaveCount(0)

  await driveWorking()

  // Two captures per call ("-working", "-done") so the second does not overwrite the first.
  const workingEvidence = withSuffix(evidence, "working")
  if (workingEvidence) await captureEvidence({ page, spec: workingEvidence.spec, scenario: workingEvidence.scenario })

  await expect(
    row.locator(`${SELECTORS.statusDot}[data-sidebar-status="working"]`),
    `rail row for session "${sessionId}" never showed a "working" status dot after transitioning off idle`,
  ).toHaveCount(1, { timeout })
  await expect(
    row.locator(`${SELECTORS.glyph} ${SELECTORS.statusDot}[data-sidebar-status="working"]`),
    `rail row for session "${sessionId}"'s working dot is not inside the left [data-slot="navigation-row-glyph"] column`,
  ).toHaveCount(1)
  await expect(
    row.locator(SELECTORS.time),
    `rail row for session "${sessionId}"'s timestamp is empty while working; the dot must sit beside it, not replace it`,
  ).toHaveText(/\S/)

  const dotX = await row.locator(SELECTORS.statusDot).evaluate((el) => el.getBoundingClientRect().left)
  const titleX = await row.locator(SELECTORS.title).evaluate((el) => el.getBoundingClientRect().left)
  expect(
    dotX,
    `rail row for session "${sessionId}"'s status dot (x=${dotX}) is not left of its own title (x=${titleX})`,
  ).toBeLessThan(titleX)

  await driveDone()

  const doneEvidence = withSuffix(evidence, "done")
  if (doneEvidence) await captureEvidence({ page, spec: doneEvidence.spec, scenario: doneEvidence.scenario })

  await expect(
    row.locator(`${SELECTORS.statusDot}[data-sidebar-status="done"]`),
    `rail row for session "${sessionId}" never settled to "done" after driveDone (expected the unseen-done state for a completed, unfocused turn)`,
  ).toHaveCount(1, { timeout })

  return row
}
