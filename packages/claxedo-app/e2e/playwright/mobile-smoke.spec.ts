/**
 * SPEC: Mobile viewport smoke (narrow-width shell contract)
 *
 * PURPOSE — the app ships one codebase for web + mobile, but per the responsive
 * appendix (`docs/plans/2026-07-10-003-claxedo-app-audit-findings-appendix.md`,
 * "responsive" section, health 4/10) genuine mobile usability of the two signature
 * multi-surface features (multipane workbench, terminal) has 0% automated coverage —
 * "there is no mobile device project in Playwright and not one E2E test sets a mobile
 * viewport, so none of this is guarded by CI." This spec is that first guard: a small
 * smoke suite that runs under the `mobile` Playwright project (`devices["iPhone 13"]`,
 * `playwright.config.ts`) and pins the handful of narrow-viewport behaviors that
 * genuinely work today, while `test.fixme`-ing the ones a real app bug or missing
 * feature makes currently unreachable — each fixme cites the exact source finding so a
 * later wave can flip it to a real test once the underlying gap is closed (LLD WP-03
 * step 1 / appendix responsive refactor-step 1: "sidebar drawer open/close,
 * WorkspacePanel full-width, chat scroll... Expect and mark known failures (multipane,
 * DnD) as test.fixme — they become Wave 3's gate").
 *
 * STATE MODEL — this spec owns no new state; it exercises the existing desktop state
 * model (`claxedo.state.v5`, `mobileSidebarOpen` signal, `WorkspacePanel`'s
 * `viewportWidth()` signal) at a narrow viewport instead of a desktop one. See
 * `core-boot-deep-links-home.spec.ts` and `core-processes.spec.ts` for the full desktop
 * versions of the state model this spec reuses unchanged.
 *
 * ANATOMY —
 *   `[data-claxedo]` — shell root (shared with every core-* spec).
 *   `[data-testid="workspace-panel-shell"]` — the workspace side panel
 *     (`src/claxedo-ui/workspace-panel/workspace-panel.tsx`); below 640px viewport
 *     width its inline `style.width` is the literal string `"100%"` (`isMobile()` at
 *     line 31, `panelStyleWidth()` at line 105) and its resize `role="separator"`
 *     handle does not render at all (`<Show when={open() && props.state.mode &&
 *     !isMobile()}>`, line 233).
 *   `[data-scrollable]:has([data-slot="session-turn-message-content"])` — the timeline
 *     scroll viewport, shared with `core-timeline-rendering-scroll.spec.ts`.
 *
 * BEHAVIORS —
 *   1. [test.fixme — dead code] The mobile sidebar drawer opens on entry, scrim-closes,
 *      and closes on session select. NOT reachable: `mobileSidebarOpen`
 *      (`src/claxedo-ui/rail/rail-shell-chrome-state.ts:18`,
 *      `createSignal(false)`) has exactly one setter anywhere in production code —
 *      `closeMobileSidebar: () => setMobileSidebarOpen(false)` (same file, line 61) —
 *      which can only ever set it to `false`. No tap/swipe/hot-zone/route-driven call
 *      site ever sets it `true`, so the drawer this behavior describes can never open
 *      from the real UI today, on any viewport. This exact dead-code path is already
 *      pinned as a `test.fixme` with full citation in
 *      `core-sidebar-tree.spec.ts:947-967` ("mobile drawer opens on entry,
 *      scrim-closes, and closes on session select — behavior 14 (dead code)"); this
 *      spec's copy exists so the `mobile` Playwright project also carries a citation of
 *      the same gap, not to duplicate the desktop project's assertion.
 *   2. The workspace side panel (opened via the "Open Processes" toolbar toggle, the
 *      same entry point `core-processes.spec.ts` uses) renders at full viewport width
 *      (`style.width === "100%"`, bounding-box width within a few px of the viewport)
 *      below the 640px `isMobile()` threshold, and its desktop-only pointer resize
 *      handle (`role="separator"`) is entirely absent from the DOM — matching the a11y
 *      appendix finding that the handle is pointer-only on desktop and simply doesn't
 *      exist here to worry a keyboard/touch user.
 *   3. A seeded session's timeline is scrollable at a narrow viewport: after driving
 *      three real turns (oracle-proven replies), the timeline's own `[data-scrollable]`
 *      viewport responds to a scroll gesture (`scrollTop` changes), proving the
 *      narrow-viewport chat surface isn't pinned/clipped in a way that defeats
 *      scrolling.
 *   4. [test.fixme — no touch-compatible implementation exists] Multipane
 *      split/rearrange and any pane/tab/session drag-reorder have no touch equivalent.
 *      Per the responsive appendix ("[critical] All pane/tab/session drag-reordering
 *      uses native HTML5 DnD — non-functional on touch" and "[critical] Multipane
 *      workbench has no narrow-viewport collapse strategy"), `workbench.tsx` computes
 *      pane rects from raw container pixels with no width threshold/collapse mode, and
 *      every reorder affordance (`workbench.tsx`, `session-navigation-list.tsx`,
 *      `terminal-surface-navigation.tsx`, `file-tree.tsx`, `CompactSwitcher.tsx`) is
 *      wired through native HTML5 `draggable`/`dragstart`/`drop`, which mobile
 *      Safari/Chrome never fire without a JS polyfill — the only existing coverage
 *      (`src/claxedo-ui/layout/tests/H-drag-drop.vitest.tsx`) simulates synthetic
 *      `DragEvent`/`DataTransfer` objects directly, so this gap is invisible to CI
 *      today. There is no touch-fallback UI (long-press menu, move-up/down buttons) to
 *      assert against yet.
 *
 * INVARIANTS — none beyond the shared oracle/turn-settling invariants in
 *   `e2e/INVARIANTS.md`, reused unchanged for behavior 3's seeded-session scenario.
 *
 * HARNESS NOTES — every scenario uses the default `opencode` harness from
 *   `installMockRuntime`; harness selection itself is out of scope (see
 *   `core-harness-ownership-local.spec.ts`).
 *
 * OUT OF SCOPE — full sidebar tree behavior (`core-sidebar-tree`); terminal soft-
 *   keyboard accessory keys (appendix responsive finding, no implementation exists to
 *   test); a real touch-compatible drag/reorder implementation (tracked as an appendix
 *   refactor step, not yet built); axe-core accessibility scanning at this viewport
 *   (`a11y-sweep.spec.ts` covers accessibility, at desktop viewport, separately).
 */
import { expect, test, type Page } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-mobile-smoke"
const SESSION_ID = "ses_mobile_smoke"

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
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

/** FINDING (verified by reading source, worked around locally — this is a real,
 * previously-undocumented mobile UX gap, not a test bug): `route-intent.ts`'s
 * `workspaceBrowse` branch (~line 489) unconditionally auto-opens the workspace panel
 * in "review" mode (`state.workspacePanel.open("review", {workspaceDir})`) whenever a
 * `/:dir/session`-shaped boot resolves to a bare workspace-browse intent (no
 * sessionId/pageId/terminalId yet) — the exact same route shape every desktop core-*
 * spec's `openWorkbench` uses. At desktop viewport this is harmless (the panel takes
 * ~70% width, leaving the draft composer visible alongside it), but at this project's
 * mobile viewport `isMobile()` (workspace-panel.tsx:31) forces `panelStyleWidth()` to
 * "100%" (line 105), so the auto-opened review panel covers the ENTIRE screen —
 * including the composer underneath — with no user action taken. Closed here via the
 * panel's own in-header toggle (`[data-testid="workspace-panel-toggle"]`, rendered
 * inside `WorkspacePanelHeader` so it stays reachable even while the panel is
 * full-width) before any test interacts with the composer. */
async function closeWorkspacePanelIfOpen(page: Page) {
  const panel = page.locator('[data-testid="workspace-panel-shell"]')
  if ((await panel.getAttribute("data-open").catch(() => null)) !== "true") return
  const closeToggle = page.locator('[data-testid="workspace-panel-toggle"][aria-label="Close workspace panel"]')
  if (!(await closeToggle.isVisible().catch(() => false))) return
  await closeToggle.click()
  await expect(panel).toHaveAttribute("data-open", "false", { timeout: 5_000 })
}

async function openWorkbench(page: Page, dir: string) {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await closeWorkspacePanelIfOpen(page)
  if (!(await page.getByRole("textbox", { name: /Ask anything/i }).isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "New Session" }).first().click()
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 10_000 })
  }
}

/** Same "Open Processes" toolbar toggle `core-processes.spec.ts` uses to open the
 * workspace side panel — reused here only to get `workspace-panel-shell` open+mounted
 * at a narrow viewport; this spec asserts nothing about the Processes feature itself. */
async function openWorkspacePanel(page: Page) {
  const toggle = page.locator('button[aria-label="Open Processes"], button[aria-label="Close Processes"]').first()
  await expect(toggle).toBeVisible({ timeout: 10_000 })
  if ((await toggle.getAttribute("aria-label")) === "Close Processes") return
  await toggle.click()
  await expect(page.locator('[data-testid="workspace-panel-shell"]')).toHaveAttribute("data-open", "true", {
    timeout: 10_000,
  })
}

async function sendTurn(page: Page, promptText: string, turn: number) {
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await input.click()
  await input.fill(promptText)
  await expect(input).toContainText(promptText, { timeout: 10_000 })
  await page.locator(SELECTORS.submitControl).last().click()
  await expectAssistantReplyVisible(page, `ack ${turn}: ${promptText}`, {
    spec: "mobile-smoke",
    scenario: `seeded-session-turn-${turn}`,
  })
}

function timelineScroller(page: Page) {
  return page.locator('[data-scrollable]:has([data-slot="session-turn-message-content"])').first()
}

test.describe("mobile smoke @happy", () => {
  test.fixme(
    "mobile sidebar drawer opens on entry, scrim-closes, and closes on session select — behavior 1 (dead code)",
    async () => {
      // REAL APP BUG, not a test gap — see this file's BEHAVIORS #1 and the identical
      // citation in core-sidebar-tree.spec.ts:947-967. `mobileSidebarOpen`
      // (src/claxedo-ui/rail/rail-shell-chrome-state.ts:18) has no production call site
      // that ever sets it `true`; `closeMobileSidebar` (line 61) is the only setter
      // anywhere, and it can only set it to `false`. There is no tap/swipe/hot-zone
      // entry point that opens the drawer on a mobile viewport today, so this behavior
      // cannot be exercised until the app wires one.
    },
  )

  test("workspace panel renders full-width with no resize handle below 640px — behavior 2", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedOneProject(page, DIR)
    await openWorkbench(page, DIR)

    await openWorkspacePanel(page)
    const panel = page.locator('[data-testid="workspace-panel-shell"]')
    await expect(panel).toHaveAttribute("data-open", "true")

    // `panelStyleWidth()` (workspace-panel.tsx:105) sets the literal inline style
    // string "100%" once `isMobile()` (viewportWidth() < 640) is true — asserted
    // against the raw inline `style` attribute, not `toHaveCSS`/`getComputedStyle`
    // (which always resolves a percentage width to its computed pixel value, so it
    // can never observe the "100%" the source code actually writes).
    await expect(panel).toHaveAttribute("style", /(?:^|;)\s*width:\s*100%\s*(?:;|$)/)
    // Confirms this isn't inert authored-but-unused CSS: the panel's actual box is
    // (near enough to) the emulated device's own viewport width, not some fixed
    // desktop-era pixel value left over from a stale style.
    const viewportWidth = page.viewportSize()?.width ?? 0
    const panelBox = await panel.boundingBox()
    expect(panelBox).not.toBeNull()
    expect(Math.abs((panelBox?.width ?? 0) - viewportWidth)).toBeLessThan(4)

    // The pointer-drag resize handle is desktop-only (`<Show when={... && !isMobile()}>`,
    // workspace-panel.tsx:233) — it must not exist in the DOM at all at this viewport,
    // not just be hidden, since a keyboard/touch user has no equivalent for it anyway
    // (a11y appendix finding).
    await expect(panel.locator('[role="separator"][aria-label="Resize workspace panel"]')).toHaveCount(0)
  })

  test("seeded session timeline scrolls at a narrow viewport — behavior 3", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedOneProject(page, DIR)
    await openWorkbench(page, DIR)

    await sendTurn(page, "mobile smoke turn one", 1)
    await sendTurn(page, "mobile smoke turn two", 2)
    await sendTurn(page, "mobile smoke turn three", 3)

    const scroller = timelineScroller(page)
    await expect(scroller).toBeVisible({ timeout: 10_000 })

    const scrollTopBefore = await scroller.evaluate((el) => el.scrollTop)
    await scroller.hover()
    for (let attempt = 0; attempt < 40; attempt++) {
      await page.mouse.wheel(0, -400)
      const current = await scroller.evaluate((el) => el.scrollTop)
      if (current < scrollTopBefore) break
    }
    const scrollTopAfter = await scroller.evaluate((el) => el.scrollTop)
    expect(scrollTopAfter).toBeLessThan(scrollTopBefore)
  })

  test.fixme(
    "multipane split and pane/tab/session drag-reorder have a touch equivalent — behavior 4 (no implementation)",
    async () => {
      // REAL APP GAP, not a test gap — see this file's BEHAVIORS #4 and the responsive
      // appendix (docs/plans/2026-07-10-003-claxedo-app-audit-findings-appendix.md,
      // "responsive" section, lines 1048-1053): every pane/tab/session reorder
      // affordance (src/claxedo-ui/layout/workbench.tsx,
      // src/claxedo-ui/navigation-islands/session-navigation-list.tsx,
      // src/claxedo-ui/navigation-islands/terminal-surface-navigation.tsx,
      // src/components/file-tree.tsx, src/claxedo-ui/compact-switcher/CompactSwitcher.tsx)
      // is wired exclusively through native HTML5 draggable/dragstart/drop, which does
      // not fire on touch devices, and workbench.tsx has no narrow-viewport collapse
      // strategy (percentage-rect absolute positioning only, no width threshold). There
      // is no touch-fallback UI (long-press menu, move up/down buttons) anywhere in
      // source to assert against yet — this test cannot be written until one exists.
    },
  )
})
