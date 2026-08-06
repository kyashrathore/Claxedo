// Rail sidebar assertions for scenario group B (session lifecycle & rail) from
// `docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md`. Every spec that claims a
// rail row is visible, retitled, reordered, unique, or status-transitioned proves it
// through this module — never through a bare `page.locator`/`getByText` on the rail DOM,
// the same discipline `turn-oracle.ts` enforces for assistant replies (see
// `e2e/INVARIANTS.md`, "The Oracle").
//
// DOM contract, captured from the live app 2026-08-06 (exact strings, not paraphrased):
//   row:    [data-testid="rail-sidebar-session-row"][data-session-id="<id>"]
//   title:  [data-slot="session-navigation-title"]
//   time:   [data-slot="session-navigation-time"]
//   dot:    [data-sidebar-status]  values: working|permission|done
//   glyph:  [data-slot="navigation-row-glyph"]  (the dot's containing column)
//   terminal row: [data-testid="rail-sidebar-terminal-row"][data-terminal-id="<id>"]
//
// None of these helpers query without an exact `data-session-id`/`data-terminal-id`, and
// none fall back to `.first()` on that scoped locator. Open issue #14 (plan line 187-192)
// makes a `session.lifecycle` frame carrying `info.workspaceID` render TWICE — once under
// a project section, once under a workspace section. `.first()` hides that by picking
// whichever copy happens to work; a strict-mode Playwright assertion on the un-narrowed
// locator surfaces it as a hard failure instead, which is what `expectRailRowUnique`
// exists to name explicitly. `.first()` is used ONLY where the assertion's subject really
// is "whichever row is first" (`expectRailRowMovesToTop`) — never as a workaround for
// row-identity ambiguity.
import { expect, type Locator, type Page } from "@playwright/test"
import { captureEvidence, type Evidence } from "./visual-evidence"

// Evidence wiring (Phase 5 closure, plan line 259-262 / INVARIANTS.md rule #2): every
// function below now accepts an OPTIONAL `evidence?: Evidence` field and, when present,
// writes `test-results/evidence/<spec>/<scenario>.png` via `captureEvidence` at the exact
// point each function makes its claim. Optional and additive on purpose — every existing
// caller (`desktop-unsigned-embedded.spec.ts`, `real-harness-local.spec.ts`) passes opts
// objects without `evidence` today, and `if (evidence) …` below means those calls are
// unaffected; only a caller that opts in pays for the screenshot.
//
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

/** The create-time placeholder titles; a settled title is anything else. */
const PLACEHOLDER_TITLE = /^(New Session|Untitled session)$/

/**
 * B1 — the row for `sessionId` becomes visible with NO reload, and (when `index` is
 * given) sits at that position among session rows. Defects 1/2/7 all manifest here: a
 * `file://`-origin API base (1), a dropped rail-list invalidation (2), and a local
 * workspace that never opened an event stream at all (7) each leave this row absent
 * until something unrelated forces a reload.
 *
 * The row locator is the exact `data-session-id` selector, un-narrowed by `.first()` — a
 * duplicate-rendered row (open issue #14) makes `toBeVisible()` throw a Playwright
 * strict-mode violation here instead of silently resolving onto one copy.
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

  // Capture BEFORE the wait/assert below (see file header): if the row never appears,
  // `toBeVisible` throws on timeout and this is the only screenshot this call will ever
  // produce — it must exist already, showing the rail in whatever state defects 1/2/7
  // left it (row absent, or present pre-reload-only).
  if (evidence) await captureEvidence({ page, spec: evidence.spec, scenario: evidence.scenario })

  await expect(
    row,
    `rail row for session "${sessionId}" never became visible without a reload (defects 1/2/7: file:// API base, dropped invalidation, or no event stream)`,
  ).toBeVisible({ timeout })

  if (index !== undefined) {
    await expect(
      page.locator(SELECTORS.allSessionRows).nth(index),
      `session "${sessionId}" was expected at rail index ${index}, but a different row occupies it`,
    ).toHaveAttribute("data-session-id", sessionId, { timeout })
  }

  return row
}

/** A settled/idle row must not retain a stale lifecycle dot. */
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
 * B3 — the rail title leaves the create-time placeholder ("New Session" /
 * "Untitled session") with NO reload, once the server's auto-title lands. Defect 8:
 * `session.updated` was dropped at the runtime bridge, so this stayed on the placeholder
 * forever, absent a reload that happened to land after some unrelated refetch.
 *
 * Polls manually rather than `expect(title).not.toHaveText(PLACEHOLDER_TITLE)`: an EMPTY
 * title also fails to match that regex, so the naive form would resolve the instant the
 * row mounts with no text at all — trivially true, and proving nothing about the
 * auto-title actually arriving. This requires non-empty text that has left the
 * placeholder, and returns the settled value so a caller can assert on its content too.
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
      // Capture at the instant the claim ("title left the placeholder") becomes true —
      // this success path has no `expect()` of its own (the function just returns), so
      // this is the only place to place the capture-before-the-claim call on the happy
      // path. A caller that immediately asserts on the returned string still gets a
      // screenshot proving the DOM state that produced it.
      if (evidence) await captureEvidence({ page, spec: evidence.spec, scenario: evidence.scenario })
      return text
    }
    if (Date.now() > deadline) {
      // Failure path: capture BEFORE the two expects below, which is what actually
      // throws defect 8's error. Without this, a timed-out title-settle proof would be
      // the one case in this module with an assertion and zero evidence.
      if (evidence) await captureEvidence({ page, spec: evidence.spec, scenario: evidence.scenario })
      expect(text.length, `rail title for session "${sessionId}" never rendered any text within ${timeout}ms`).toBeGreaterThan(0)
      expect(
        text,
        `rail title for session "${sessionId}" is still the create-time placeholder "${text}" after ${timeout}ms (defect 8: session.updated dropped at the runtime bridge)`,
      ).not.toMatch(PLACEHOLDER_TITLE)
      return text // unreachable: one of the two expects above always throws first
    }
    await page.waitForTimeout(250)
  }
}

/**
 * B5 — after being re-prompted, an older row reaches rail index 0. Asserted on
 * whichever row IS first, rather than on the target row's own index, so a failure names
 * whichever row wrongly outranks it — mirrors `core-claude-native-sdk-rail.spec.ts`
 * lines 326-333. Defect 10: the reconcile rewrote a row's `updatedAt` in place with no
 * re-sort, so a 30-second-old row sat at position 6 under rows 12-29 minutes older.
 */
export async function expectRailRowMovesToTop(opts: {
  page: Page
  sessionId: string
  timeout?: number
  evidence?: Evidence
}): Promise<void> {
  const { page, sessionId, timeout = DEFAULT_TIMEOUT, evidence } = opts
  // Capture before the assert (file header rationale): a failure here means "the WRONG
  // row is at index 0", and the screenshot is the only artifact that shows which row that
  // actually is without a reviewer re-running the spec under a debugger.
  if (evidence) await captureEvidence({ page, spec: evidence.spec, scenario: evidence.scenario })
  await expect(
    page.locator(SELECTORS.allSessionRows).first(),
    `expected session "${sessionId}" at rail index 0 after being re-prompted, but a different row still outranks it (defect 10: reconcile rewrote updatedAt with no re-sort)`,
  ).toHaveAttribute("data-session-id", sessionId, { timeout })
}

/**
 * B6 — exactly ONE row renders per session id. Open issue #14 (plan line 187-192): a
 * session announced by a `session.lifecycle` frame carrying `info.workspaceID` renders
 * TWICE — once under a project section (`data-session-ref="<id>"`), once under a
 * workspace section (`data-session-ref="workspace:<wsId>:session:<id>"`). Adopting this
 * helper converts that from tolerated (`core-claude-native-sdk-rail.spec.ts` routes
 * around it with `.first()`) to blocking.
 */
export async function expectRailRowUnique(opts: {
  page: Page
  sessionId: string
  timeout?: number
  evidence?: Evidence
}): Promise<void> {
  const { page, sessionId, timeout = DEFAULT_TIMEOUT, evidence } = opts
  // Capture before the assert (file header rationale): a duplicate-row failure is exactly
  // the kind of defect a screenshot settles at a glance (two rows for the same session,
  // one under each section) where the count-mismatch error message alone does not show
  // WHERE the second row rendered.
  if (evidence) await captureEvidence({ page, spec: evidence.spec, scenario: evidence.scenario })
  await expect(
    page.locator(SELECTORS.sessionRow(sessionId)),
    `expected exactly one rail row for session "${sessionId}" (open issue #14: a workspaceID-carrying frame double-renders into a project row AND a workspace row)`,
  ).toHaveCount(1, { timeout })
}

/**
 * B7 — the background status dot transitions working -> done on a row that is never
 * focused. Defect 12: a Solid component body runs ONCE; an early
 * `if (status === "idle") return null` froze the glyph at whatever status existed at
 * MOUNT, so a row that started idle and only later went "working" never grew a dot at
 * all. A test that queries/mounts the row only AFTER the status is already "working"
 * cannot see that freeze — it would pass against broken code exactly as well as fixed
 * code, which is precisely how defect 12 shipped undetected.
 *
 * This helper closes that hole structurally rather than trusting the caller's ordering:
 * it asserts the row is visible AND idle (dot count 0) itself, before calling
 * `driveWorking`, so every use of this oracle is provably mounted pre-status. Compare to
 * `core-claude-native-sdk-rail.spec.ts` lines 393-425, whose sequence (visible -> assert
 * no dot -> emit busy -> assert dot) this generalizes.
 *
 * `driveWorking`/`driveDone` are the caller's own transport calls (real SSE via
 * `mock.emitFlat()`/`mock.emit()`, or a real Tier R/L lane) — this module owns
 * assertions, not transport, per `e2e/INVARIANTS.md` cross-cutting rule 8: the DEV
 * direct-bus seam (`window.__claxedoEmitTestEvent`) must never be the sole delivery path
 * for a transport-dependent proof.
 *
 * The dot and the timestamp are asserted present TOGETHER while working: the pre-fix
 * layout sacrificed the timestamp to show the dot on the right; the fix moved the dot
 * into the left `navigation-row-glyph` gutter so both render at once (defect 11).
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

  // Mount-while-idle proof (the defect-12 gate): the dot must be ABSENT right now,
  // before any status is driven, or this scenario cannot tell a working transition
  // apart from a component that only ever renders whatever status it saw at mount.
  await expect(
    row.locator(SELECTORS.statusDot),
    `rail row for session "${sessionId}" already carries a status dot before this oracle drove one — the idle-mount precondition the defect-12 proof depends on does not hold`,
  ).toHaveCount(0)

  await driveWorking()

  // Capture BEFORE the working-dot assert, suffixed "-working" — this is a two-claim
  // scenario (working, then done) and one evidence PNG per call would silently overwrite
  // itself between the two states if both used the bare scenario name. `withSuffix`
  // (file header) keeps the two claims as two distinct, permanently-inspectable files.
  const workingEvidence = withSuffix(evidence, "working")
  if (workingEvidence) await captureEvidence({ page, spec: workingEvidence.spec, scenario: workingEvidence.scenario })

  await expect(
    row.locator(`${SELECTORS.statusDot}[data-sidebar-status="working"]`),
    `rail row for session "${sessionId}" never showed a "working" status dot after transitioning off idle (defect 12: the glyph froze at its mount status)`,
  ).toHaveCount(1, { timeout })
  await expect(
    row.locator(`${SELECTORS.glyph} ${SELECTORS.statusDot}[data-sidebar-status="working"]`),
    `rail row for session "${sessionId}"'s working dot is not inside the left [data-slot="navigation-row-glyph"] column (defect 11: the dot was orphaned at x=11, left of the workspace icon)`,
  ).toHaveCount(1)
  await expect(
    row.locator(SELECTORS.time),
    `rail row for session "${sessionId}"'s timestamp is empty while working (defect 11: the dot used to replace the timestamp instead of sitting beside it in the glyph column)`,
  ).toHaveText(/\S/)

  const dotX = await row.locator(SELECTORS.statusDot).evaluate((el) => el.getBoundingClientRect().left)
  const titleX = await row.locator(SELECTORS.title).evaluate((el) => el.getBoundingClientRect().left)
  expect(
    dotX,
    `rail row for session "${sessionId}"'s status dot (x=${dotX}) is not left of its own title (x=${titleX})`,
  ).toBeLessThan(titleX)

  await driveDone()

  // Same reasoning as the working-side capture above, suffixed "-done" for the second
  // claim of this two-claim scenario.
  const doneEvidence = withSuffix(evidence, "done")
  if (doneEvidence) await captureEvidence({ page, spec: doneEvidence.spec, scenario: doneEvidence.scenario })

  // Never focused by this oracle's caller (that's the scenario's whole point), so a
  // settled turn must land on "done" (unseen), never silently revert to no-dot idle —
  // the invariant `core-sidebar-tree.spec.ts` behavior 4 documents.
  await expect(
    row.locator(`${SELECTORS.statusDot}[data-sidebar-status="done"]`),
    `rail row for session "${sessionId}" never settled to "done" after driveDone (expected the unseen-done state for a completed, unfocused turn)`,
  ).toHaveCount(1, { timeout })

  return row
}
