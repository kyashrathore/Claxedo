// The sidebar rail and the compact-switcher tab strip each render their own
// status dot from independent components (`data-sidebar-status` and
// `data-switcher-status`). The exports below assert EQUALITY between the two,
// never presence on either alone: independent presence checks let the two
// surfaces drift apart while both stay green.
//
// `CompactSwitcher` exists in the DOM only while the sidebar rail is un-pinned,
// so clicking the sidebar toggle is also what MOUNTS it — every tab in it,
// freshly. `expectSurfaceParity` bookends every call with a close+reopen of the
// sidebar, so it always reads a brand-new mount and can never observe a status
// change on an already-mounted tab; `expectSurfaceStatus` is the variant that
// never touches the sidebar toggle, for exactly that reason.
import { expect, type Locator, type Page } from "@playwright/test"

/** Mirrors `SwitcherStatus` (compact-switcher/switcher-items.ts:4) and the
 * status union `NavigationStatusDot` accepts (navigation-row.tsx:172) —
 * defined locally rather than imported so this helper stays as
 * self-contained as turn-oracle.ts's SELECTORS, not coupled to an app source
 * path that e2e/ has no other reason to import from. */
export type SurfaceStatus = "idle" | "working" | "permission" | "done"

export type ParityEvidence = {
  sessionId: string
  /** Title read off the rail row at the moment of the check. The rail does
   * not expose the matching workbench content id, so status parity correlates
   * the two surfaces by their shared projected title. */
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
 * Locates the compact-switcher tab for the title read from a rail row. The
 * switcher now exposes its workbench content id, but the rail row exposes the
 * runtime session id instead, so title text remains the shared signal for
 * cross-surface status checks. Both titles come from the same session title
 * projection, so
 * matching on it is the same correlation `core-session-actions.spec.ts`'s
 * "switcher tab title sync" test relies on (it only skips the filter because
 * that spec keeps exactly one tab open). Exact match via an anchored RegExp,
 * not Playwright's substring `hasText`, so "Session" cannot match "New
 * Session". `.first()` remains a tolerated gap for status checks when two
 * runtime sessions have the same projected title; direct switcher navigation
 * uses `data-content-id` below and does not share that ambiguity.
 */
function switcherTabForTitle(page: Page, title: string): Locator {
  const exact = new RegExp(`^${escapeRegExp(title)}$`)
  return page
    .locator(`${SELECTORS.switcherRoot} ${SELECTORS.switcherTab}`)
    .filter({ has: page.locator(SELECTORS.switcherTitle, { hasText: exact }) })
    .first()
}

function switcherTabForContentId(page: Page, contentId: string): Locator {
  return page.locator(`${SELECTORS.switcherTab}[data-content-id=${JSON.stringify(contentId)}]`)
}

export async function activeSwitcherContentId(page: Page): Promise<string> {
  const activeTab = page.locator(SELECTORS.switcherTab).filter({
    has: page.locator('[data-slot="workbench-tab"][data-selected="true"]'),
  })
  await expect(activeTab, "compact switcher has no active tab").toHaveCount(1)
  const contentId = await activeTab.getAttribute("data-content-id")
  expect(contentId, "active compact-switcher tab has no stable content identity").toBeTruthy()
  return contentId!
}

/** Focus one already-mounted compact-switcher tab without remounting the strip. */
export async function focusSwitcherTab(
  page: Page,
  target: string | { contentId: string; title: string },
): Promise<void> {
  const title = typeof target === "string" ? target : target.title
  const tab = typeof target === "string"
    ? switcherTabForTitle(page, title)
    : switcherTabForContentId(page, target.contentId)
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
 * `[data-testid="compact-switcher"]` enters the DOM, so this function waits for
 * the switcher root to actually mount, not just for the toggle click to resolve.
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

  const before = await readRailRow(page, sessionId)
  expect(
    before.status,
    `rail row for session "${sessionId}" reports data-sidebar-status="${before.status}", expected "${expected}" BEFORE the sidebar was touched`,
  ).toBe(expected)

  await closeSidebar(page)

  const tab = switcherTabForTitle(page, before.title)
  await expect(
    tab,
    `no compact-switcher-tab titled "${before.title}" (session "${sessionId}") after collapsing the sidebar`,
  ).toBeVisible({ timeout: 10_000 })

  const switcherStatus = await readSwitcherStatusFromTab(tab)

  // Two separate assertions: each surface against the ground-truth `expected`
  // first, so a defect that freezes BOTH dots at the same wrong value cannot
  // hide behind a bare cross-equality check; then the cross-check itself.
  expect(
    switcherStatus,
    `data-switcher-status="${switcherStatus}" but expected "${expected}" for session "${sessionId}" (title "${before.title}")`,
  ).toBe(expected)
  expect(
    switcherStatus,
    `data-sidebar-status="${before.status}" and data-switcher-status="${switcherStatus}" DISAGREE for session "${sessionId}" (title "${before.title}") — the two surfaces have drifted apart`,
  ).toBe(before.status)

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

async function readTerminalRailStatus(page: Page, terminalId: string): Promise<SurfaceStatus> {
  const selector = `[data-testid="rail-sidebar-terminal-row"][data-terminal-id="${terminalId}"]`
  const row = page.locator(selector)
  await expect(
    row,
    `rail row for terminal "${terminalId}" never appeared (${selector})`,
  ).toBeVisible({ timeout: 15_000 })
  const dot = row.locator(SELECTORS.railStatus)
  if ((await dot.count()) === 0) return "idle"
  return (await dot.first().getAttribute("data-sidebar-status")) as SurfaceStatus
}

/**
 * Assert sidebar/compact-tab parity for the active terminal. Terminal tabs do
 * not expose their content id in CompactSwitcher DOM, so active selection is
 * the canonical correlation signal for this terminal-specific oracle.
 */
export async function expectActiveTerminalSurfaceParity(opts: {
  page: Page
  terminalId: string
  expected: SurfaceStatus
}): Promise<{ terminalId: string; sidebarStatus: SurfaceStatus; switcherStatus: SurfaceStatus }> {
  const { page, terminalId, expected } = opts
  const sidebarStatus = await readTerminalRailStatus(page, terminalId)
  expect(
    sidebarStatus,
    `rail row for terminal "${terminalId}" reports data-sidebar-status="${sidebarStatus}", expected "${expected}"`,
  ).toBe(expected)

  await closeSidebar(page)
  const tab = page.locator(SELECTORS.switcherTab).filter({
    has: page.locator('[data-slot="workbench-tab"][data-selected="true"]'),
  }).first()
  await expect(tab, `active compact-switcher tab for terminal "${terminalId}" never appeared`).toBeVisible({
    timeout: 10_000,
  })
  const switcherStatus = await readSwitcherStatusFromTab(tab)
  expect(
    switcherStatus,
    `active compact tab reports data-switcher-status="${switcherStatus}", expected "${expected}" for terminal "${terminalId}"`,
  ).toBe(expected)
  expect(
    switcherStatus,
    `terminal "${terminalId}" disagrees across surfaces: sidebar="${sidebarStatus}", compact-tab="${switcherStatus}"`,
  ).toBe(sidebarStatus)

  await openSidebar(page)
  const restoredSidebarStatus = await readTerminalRailStatus(page, terminalId)
  expect(restoredSidebarStatus).toBe(expected)
  return { terminalId, sidebarStatus: restoredSidebarStatus, switcherStatus }
}
