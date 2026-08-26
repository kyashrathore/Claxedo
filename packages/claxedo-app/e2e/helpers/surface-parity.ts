// Scenario B9 oracle — docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md.
//
// The sidebar rail and the compact-switcher tab strip each render their OWN
// status dot from independent components: `NavigationStatusDot`
// (navigation-row.tsx:172-192, `data-sidebar-status`) and `StatusDot`
// (compact-switcher.tsx:27-44, `data-switcher-status`). compact-switcher.tsx:
// 28-29 carries a comment claiming the two are "kept in sync with
// NavigationStatusDot" — a claim with no test behind it before this file.
// `expectSurfaceParity`/`expectSurfaceStatus` below assert EQUALITY between
// the two, never presence on either alone: asserting presence independently
// lets the surfaces drift apart while both stay green, which is exactly the
// failure mode a "kept in sync" comment with no test invites.
//
// SUSPECT, UNVERIFIED — do not read this as a bug report. compact-switcher.tsx
// :31's StatusDot has the same early-return-in-body shape that caused defect
// #12 in NavigationStatusDot: `if (!props.status || props.status === "idle")
// return null`, inside a component whose body Solid runs exactly once.
// NavigationStatusDot has the identical shape and is safe only because every
// caller wraps it in `<Show when={status !== "idle"}>`
// (`NavigationRowStatusGutter`, navigation-row.tsx:150-165, with a comment
// naming defect #12 by number). compact-switcher.tsx:63-67's
// `SwitcherPrefixMark` ALSO wraps its `StatusDot` in
// `<Show when={hasVisibleStatus(item)}>` — so on paper the same guard exists
// there too. Whether that guard actually protects an already-mounted tab from
// freezing at its mount-time status depends on whether Solid's `<Show>`
// (non-keyed) truly remounts a fresh `StatusDot` instance on every idle→
// visible transition, given `itemById()` rebuilds a new `SwitcherItem` object
// on every recompute (compact-switcher.tsx:168-175's own comment about `<For>`
// keying). That has NOT been measured. `expectSurfaceStatus` is the
// experiment that settles it; nothing in this file assumes an answer either
// way.
//
// MEASURED, separately: `CompactSwitcher` itself only exists in the DOM while
// the sidebar rail is un-pinned — `workbench-shell-header.tsx:107` wraps both
// the "Show Sidebar" button and `<CompactSwitcher>` (line 126) in one
// `<Show when={!props.sidebarPinned()}>`. Clicking `[data-testid=
// "sidebar-toggle"]` (rail-sidebar.tsx:2555, only rendered `when={docked()}`)
// is what un-pins the rail and is therefore also what MOUNTS CompactSwitcher
// — every tab in it, freshly. That has a real consequence for the two exports
// below: `expectSurfaceParity` bookends every call with a close+reopen of the
// sidebar, so calling it twice in a row gives the tab a BRAND NEW mount each
// time — a fresh mount can never observe the frozen-at-mount shape of defect
// #12, because the freeze (if it exists) only shows up on a status change
// AFTER mount. `expectSurfaceStatus` is the variant that never touches the
// sidebar toggle, for exactly that reason — see its own doc comment.
import { expect, type Locator, type Page } from "@playwright/test"

/** Mirrors `SwitcherStatus` (compact-switcher/switcher-items.ts:4) and the
 * status union `NavigationStatusDot` accepts (navigation-row.tsx:172) —
 * defined locally rather than imported so this helper stays as
 * self-contained as turn-oracle.ts's SELECTORS, not coupled to an app source
 * path that e2e/ has no other reason to import from. */
export type SurfaceStatus = "idle" | "working" | "permission" | "done"

export type ParityEvidence = {
  sessionId: string
  /** Title read off the rail row at the moment of the check — the only
   * signal this module can correlate a compact-switcher tab against (see
   * `switcherTabForTitle`). */
  title: string
  sidebarStatus: SurfaceStatus
  switcherStatus: SurfaceStatus
}

const SELECTORS = {
  railRow: (sessionId: string) => `[data-testid="rail-sidebar-session-row"][data-session-id="${sessionId}"]`,
  railStatus: "[data-sidebar-status]",
  railTitle: '[data-slot="session-navigation-title"]',
  sidebarToggle: '[data-testid="sidebar-toggle"]',
  switcherRoot: '[data-testid="compact-switcher"]',
  switcherTab: '[data-testid="compact-switcher-tab"]',
  switcherTitle: '[data-testid="switcher-title"]',
  switcherStatus: "[data-switcher-status]",
} as const

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Reads the rail row's status AND title in one pass — every caller below
 * needs the title immediately after to locate the matching switcher tab, so
 * this avoids re-locating the row a second time (the same re-query-races
 * concern turn-oracle.ts's `domTruth`/`geometricTruth` split documents).
 *
 * Absence of `[data-sidebar-status]` IS "idle", not an unknown state:
 * `NavigationRowStatusGutter` (navigation-row.tsx:150-165) wraps the dot in
 * `<Show when={status !== "idle"}>`, so idle renders no dot at all. Note also
 * that dot only ever renders for NESTED rows —
 * `session-navigation-list.tsx:83` gates `NavigationRowStatusGutter` behind
 * `<Show when={props.row.nested}>` — a top-level (ungrouped) row shows no dot
 * regardless of status, which is a rail precondition unrelated to anything
 * this file tests; a caller whose session row is not nested will see every
 * status read back as "idle" no matter what the server reports.
 */
async function readRailRow(page: Page, sessionId: string): Promise<{ status: SurfaceStatus; title: string }> {
  const row = page.locator(SELECTORS.railRow(sessionId))
  await expect(row, `rail row for session "${sessionId}" never appeared (${SELECTORS.railRow(sessionId)})`).toBeVisible({
    timeout: 15_000,
  })
  return await row.evaluate((element, selectors) => {
    const dot = element.querySelector(selectors.railStatus)
    const title = element.querySelector(selectors.railTitle)?.textContent?.trim() ?? ""
    return {
      status: (dot?.getAttribute("data-sidebar-status") ?? "idle") as SurfaceStatus,
      title,
    }
  }, { railStatus: SELECTORS.railStatus, railTitle: SELECTORS.railTitle })
}

/**
 * Locates the compact-switcher tab for `title`. `compact-switcher-tab`
 * carries no session/content id anywhere in its DOM — verified by grepping
 * every `data-*` attribute in compact-switcher.tsx: `SwitcherItem.contentId`
 * (a workbench content id, not the session id — switcher-items.ts:109) is
 * never stamped onto the tab. Title text
 * (`[data-testid="switcher-title"]`, `item().title`) is the one signal the
 * tab shares with the rail row (`[data-slot="session-navigation-title"]`,
 * `row.title`) — both are rendered from the same session's title, so
 * matching on it is the same correlation `core-session-actions.spec.ts`'s
 * "switcher tab title sync" test relies on (it only skips the filter because
 * that spec keeps exactly one tab open). Exact match via an anchored RegExp,
 * not Playwright's substring `hasText`, so "Session" cannot match "New
 * Session". `.first()` if two sessions share a title — the same tolerated gap
 * as defect #14's `.first()` workaround; this oracle cannot resolve a title
 * collision it has no other identifying signal to break.
 */
function switcherTabForTitle(page: Page, title: string): Locator {
  const exact = new RegExp(`^${escapeRegExp(title)}$`)
  return page
    .locator(`${SELECTORS.switcherRoot} ${SELECTORS.switcherTab}`)
    .filter({ has: page.locator(SELECTORS.switcherTitle, { hasText: exact }) })
    .first()
}

/** Focus one already-mounted compact-switcher tab without remounting the strip. */
export async function focusSwitcherTab(page: Page, title: string): Promise<void> {
  const tab = switcherTabForTitle(page, title)
  await expect(tab, `no compact-switcher-tab titled "${title}"`).toBeVisible({ timeout: 10_000 })
  await tab.locator('[data-testid="switcher-title-button"]').click()
  // Compact-switcher selection commits after a short debounce. Returning on
  // click lets the caller resolve the previously active composer's textbox
  // and then wait forever trying to interact with a stale pane.
  await expect(
    tab.locator('[data-slot="workbench-tab"]'),
    `compact-switcher-tab titled "${title}" never became the active pane`,
  ).toHaveAttribute("data-selected", "true", { timeout: 10_000 })
}

/** Absence of `[data-switcher-status]` IS "idle" — same reasoning as
 * `readRailRow`, mirrored on `StatusDot`'s own early return
 * (compact-switcher.tsx:31) and `SwitcherPrefixMark`'s enclosing
 * `<Show when={hasVisibleStatus(item)}>` (compact-switcher.tsx:63). */
async function readSwitcherStatusFromTab(tab: Locator): Promise<SurfaceStatus> {
  const dot = tab.locator(SELECTORS.switcherStatus)
  if ((await dot.count()) === 0) return "idle"
  return (await dot.first().getAttribute("data-switcher-status")) as SurfaceStatus
}

/**
 * Collapses/un-pins the sidebar rail. This is also the ONLY way
 * `[data-testid="compact-switcher"]` enters the DOM — see the file header's
 * `workbench-shell-header.tsx:107` finding — so this function waits for the
 * switcher root to actually mount, not just for the toggle click to resolve.
 */
export async function closeSidebar(page: Page): Promise<void> {
  const toggle = page.locator(SELECTORS.sidebarToggle)
  await expect(toggle, "sidebar-toggle button not visible — sidebar may already be collapsed/un-pinned").toBeVisible({
    timeout: 10_000,
  })
  await toggle.click()
  await expect(
    page.locator(SELECTORS.switcherRoot),
    'compact-switcher never mounted after collapsing the sidebar (workbench-shell-header.tsx:107 "<Show when={!sidebarPinned()}>" gate)',
  ).toBeVisible({ timeout: 10_000 })
}

/**
 * Re-pins the sidebar rail via the header's "Show Sidebar" affordance (no
 * `data-testid`; matched by its `aria-label`, same as
 * `core-sidebar-tree.spec.ts:1087`). This UNMOUNTS `CompactSwitcher` and
 * every tab in it (same Show gate, inverted) — callers mid-transition-
 * experiment must not call this until they are done observing that tab.
 */
export async function openSidebar(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Show Sidebar" }).click()
  await expect(page.locator(SELECTORS.sidebarToggle), "sidebar-toggle button never reappeared after re-opening the sidebar").toBeVisible(
    { timeout: 10_000 },
  )
}

/**
 * The full B9 scenario, single-shot: read the rail, collapse the sidebar,
 * find the session's tab, read the switcher, assert equality, re-open the
 * sidebar, assert the rail survived the round trip. Each of the six steps
 * from the plan's B9 row, in order.
 *
 * Do NOT call this twice in a row expecting to observe a status transition on
 * the same tab instance — the close/reopen bookend means every call remounts
 * a fresh `CompactSwitcher` (file header). Use `expectSurfaceStatus` for that.
 */
export async function expectSurfaceParity(opts: {
  page: Page
  sessionId: string
  expected: SurfaceStatus
}): Promise<ParityEvidence> {
  const { page, sessionId, expected } = opts

  // 1. Rail truth, sidebar still pinned/open.
  const before = await readRailRow(page, sessionId)
  expect(
    before.status,
    `rail row for session "${sessionId}" reports data-sidebar-status="${before.status}", expected "${expected}" BEFORE the sidebar was touched`,
  ).toBe(expected)

  // 2. Close the sidebar — mounts the compact switcher.
  await closeSidebar(page)

  // 3. Find this session's tab, correlated by the title just read off the rail row.
  const tab = switcherTabForTitle(page, before.title)
  await expect(
    tab,
    `no compact-switcher-tab titled "${before.title}" (session "${sessionId}") after collapsing the sidebar`,
  ).toBeVisible({ timeout: 10_000 })

  // 4. Switcher truth.
  const switcherStatus = await readSwitcherStatusFromTab(tab)

  // 5. EQUALITY — the whole point of this oracle (file header). Two separate
  // assertions: each surface against the ground-truth `expected` first, so a
  // defect that freezes BOTH dots at the same wrong value cannot hide behind
  // a bare cross-equality check; then the cross-check itself, which is the
  // literal "kept in sync" claim compact-switcher.tsx:28-29 makes.
  expect(
    switcherStatus,
    `data-switcher-status="${switcherStatus}" but expected "${expected}" for session "${sessionId}" (title "${before.title}")`,
  ).toBe(expected)
  expect(
    switcherStatus,
    `data-sidebar-status="${before.status}" and data-switcher-status="${switcherStatus}" DISAGREE for session "${sessionId}" (title "${before.title}") — the two surfaces have drifted apart`,
  ).toBe(before.status)

  // 6. Re-open and confirm the rail survived the round trip.
  await openSidebar(page)
  const after = await readRailRow(page, sessionId)
  expect(
    after.status,
    `rail row for session "${sessionId}" reports data-sidebar-status="${after.status}" after re-opening the sidebar, expected "${expected}" to have survived the round trip`,
  ).toBe(expected)

  return { sessionId, title: before.title, sidebarStatus: after.status, switcherStatus }
}

/**
 * The transition experiment (file header): asserts rail/switcher equality
 * against `expected` WITHOUT touching the sidebar toggle at all, so the
 * compact-switcher tab a caller is inspecting is whatever DOM node has been
 * sitting there since `closeSidebar` last ran — never a fresh mount.
 *
 * Usage to actually exercise defect #12's shape on the compact switcher:
 *   1. `await closeSidebar(page)` once, while the session is still idle.
 *   2. `await expectSurfaceStatus({ page, sessionId, expected: "idle" })` —
 *      confirms both dots start absent and captures the tab's identity.
 *   3. Drive the session busy → done externally (`mock.setSessionStatus` +
 *      `mock.emit(...)`, the pattern `core-sidebar-tree.spec.ts`'s "behavior 4"
 *      tests use) — WITHOUT calling `closeSidebar`/`openSidebar` again.
 *   4. `await expectSurfaceStatus({ page, sessionId, expected: "working" })`,
 *      then `"done"`.
 * If `compact-switcher.tsx:31`'s early return ever does freeze the glyph at
 * its mount-time idle status, step 4 is what goes red — a
 * `expectSurfaceParity` round trip would not catch it, because a fresh mount
 * (which every `expectSurfaceParity` call produces) never touches the frozen
 * branch.
 */
export async function expectSurfaceStatus(opts: {
  page: Page
  sessionId: string
  expected: SurfaceStatus
}): Promise<ParityEvidence> {
  const { page, sessionId, expected } = opts

  const rail = await readRailRow(page, sessionId)
  expect(
    rail.status,
    `rail row for session "${sessionId}" reports data-sidebar-status="${rail.status}", expected "${expected}"`,
  ).toBe(expected)

  const tab = switcherTabForTitle(page, rail.title)
  await expect(
    tab,
    `no compact-switcher-tab titled "${rail.title}" (session "${sessionId}") — call closeSidebar(page) before the first expectSurfaceStatus`,
  ).toBeVisible({ timeout: 10_000 })
  const switcherStatus = await readSwitcherStatusFromTab(tab)

  expect(
    switcherStatus,
    `data-switcher-status="${switcherStatus}" but expected "${expected}" for session "${sessionId}" (title "${rail.title}") on an ALREADY-MOUNTED tab — matches the shape of defect #12 if this is idle/absent when the rail already moved on`,
  ).toBe(expected)
  expect(
    switcherStatus,
    `data-sidebar-status="${rail.status}" and data-switcher-status="${switcherStatus}" DISAGREE for session "${sessionId}" (title "${rail.title}")`,
  ).toBe(rail.status)

  return { sessionId, title: rail.title, sidebarStatus: rail.status, switcherStatus }
}
