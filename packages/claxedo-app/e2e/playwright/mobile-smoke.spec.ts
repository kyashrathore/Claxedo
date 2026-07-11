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
 *   2. The workspace side panel (opened via the header `workspace-panel-toggle`
 *      button — the narrow-width entry point, since the L2 "Open Processes" toggle
 *      `core-processes.spec.ts` uses at desktop is not rendered until a review/process
 *      context is up, which WP-C3 §3.2 no longer auto-opens here) renders at full width
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

async function openWorkbench(page: Page, dir: string) {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  // WP-C3 §3.2: the workspace review panel no longer auto-opens at narrow width
  // (`route-intent.ts` narrow guard), so the full-screen-panel-over-composer
  // workaround this spec used to need (`closeWorkspacePanelIfOpen`) is gone. The
  // panel must be closed on a bare narrow boot — asserted in behavior 2b.
  if (!(await page.getByRole("textbox", { name: /Ask anything/i }).isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "New Session" }).first().click()
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 10_000 })
  }
}

/** Open the workspace side panel via the header `workspace-panel-toggle` button —
 * the entry point that is genuinely present at a NARROW boot. (behavior 2b / WP-C3
 * §3.2 suppresses the review-panel auto-open at phone width, so the L2 "Open
 * Processes" toolbar toggle `core-processes.spec.ts` uses at desktop is not rendered
 * here — it only appears once a review/process context is already up. The
 * always-present `workspace-panel-toggle`, `aria-label="Open workspace panel"`, is
 * the correct narrow-viewport opener.) This spec asserts nothing about which
 * navigator the panel shows — only that the shell opens+mounts full-width. */
async function openWorkspacePanel(page: Page) {
  const toggle = page.locator('[data-testid="workspace-panel-toggle"]').first()
  await expect(toggle).toBeVisible({ timeout: 10_000 })
  if ((await toggle.getAttribute("aria-label")) === "Close workspace panel") return
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
  test("mobile sidebar drawer opens via the opener and scrim-closes — behavior 1", async ({ page }) => {
    // WP-C3 §3.1 flipped this from dead code: `openMobileSidebar`
    // (rail-shell-chrome-state.ts) is now a real setter, reachable on a phone via
    // the `md:hidden` opener button in rail-sidebar-shell.tsx. The desktop header
    // "Show Sidebar" button stays `md:flex hidden`, so the phone needs its own
    // affordance — this test exercises exactly that entry point + the scrim close.
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedOneProject(page, DIR)
    await openWorkbench(page, DIR)

    const opener = page.locator('[data-testid="mobile-sidebar-opener"]')
    const scrim = page.locator('[data-testid="mobile-sidebar-scrim"]')

    // Closed on entry: the opener is visible, the scrim/drawer are not.
    await expect(opener).toBeVisible({ timeout: 10_000 })
    await expect(scrim).toHaveCount(0)

    // Opener opens the drawer (scrim appears; opener hides while open).
    await opener.click()
    await expect(scrim).toBeVisible({ timeout: 5_000 })
    await expect(opener).toBeHidden()

    // Tapping the scrim (right of the 280px drawer) closes it and restores the opener.
    await scrim.click({ position: { x: 340, y: 400 } })
    await expect(scrim).toHaveCount(0)
    await expect(opener).toBeVisible()
  })

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

  test("workspace review panel does NOT auto-open at narrow boot — behavior 2b", async ({ page }) => {
    // WP-C3 §3.2: `route-intent.ts`'s `workspaceBrowse` branch used to
    // unconditionally `workspacePanel.open("review", …)`, which at phone width
    // (`isMobile()` → 100% panel) buried the composer with no user action. The
    // narrow guard suppresses it; the draft composer is the boot surface. This is
    // why `openWorkbench` no longer needs the old `closeWorkspacePanelIfOpen`.
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedOneProject(page, DIR)
    await page.goto(`/${slug(DIR)}/session`)
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    const panel = page.locator('[data-testid="workspace-panel-shell"]')
    // Either absent, or present-but-closed — never auto-opened full-screen.
    if ((await panel.count()) > 0) {
      await expect(panel).toHaveAttribute("data-open", "false", { timeout: 10_000 })
    }
    // The composer is reachable without dismissing any panel.
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 10_000 })
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
    "multipane split and pane/tab/session drag-reorder have a touch equivalent — behavior 4",
    async () => {
      // ENGINE: shipped and UNIT-PROVEN. WP-C3 replaced native HTML5 DnD with a
      // hand-rolled pointer-events engine (mouse + touch + pen) —
      // `src/claxedo-ui/workbench/pointer-drag.ts` (`workbenchDrag` +
      // `useDragSource`), adopted by the pane grip (workbench.tsx), the tab strip
      // (compact-switcher.tsx), and sidebar rows (navigation-row.tsx). WP-C3a fixed
      // its real-input defects: contentId resolution is deferred to drag-begin (no
      // session side effect on tap), `touch-action` is per-surface (pan-y/pan-x, not
      // a scroll-killing `none`), and the pane-drag source now lives on a
      // pointer-events:auto grip (it was on a pointer-events:none overlay — dead).
      // All proven by `pointer-drag.vitest.tsx` + `tests/H-drag-drop.vitest.tsx`
      // (incl. a real-input guard that the grip, not its wrapper, receives input).
      //
      // WHY STILL fixme (WP-C3a, evidence-based — not the stale native-DnD reason):
      // an ENFORCED end-to-end touch assertion has no assertable surface AT PHONE
      // WIDTH in this harness. Verified empirically on iPhone 13 (390px) against the
      // default mock runtime, after driving a real turn:
      //   (a) Split geometry is UNOBSERVABLE below BP_MD (768):
      //       `workbench/collapse-projection.ts` (`isCollapsedWidth`,
      //       `collapsePaneRects`) renders exactly ONE full-bleed pane and hides the
      //       rest — a 2-pane split is preserved-but-hidden, so `drop-target-*` /
      //       split rects can't be asserted at any phone viewport. Flipping THIS
      //       assertion needs a canvas width >= 768 (a tablet project), not a phone.
      //   (b) The compact-switcher tab strip renders ZERO tabs at phone width with a
      //       single session (`[data-testid="switcher-title-button"]`.count() === 0),
      //       so there is no tab to touch-drag.
      //   (c) The sidebar drawer lists ZERO session rows
      //       (`[data-testid="rail-sidebar-session-row"]`.count() === 0) — the mock
      //       runtime's session list is empty, so there is no row to touch-drag.
      // (CDP `Input.dispatchTouchEvent` touch dispatch itself works and DOES drive
      // the pointer engine — the block is surface availability/seed, not touch input.)
      //
      // TO FLIP: a tablet-width (>= BP_MD 768) project plus a pre-seeded multi-surface
      // fixture (2 panes, or 2+ switcher tabs) whose SHAPE — `claxedo.state.v5`
      // localStorage vs a driven gesture — the design note §7 reserves to the
      // fixture-convention owner. Then CDP touch long-press on a tab/grip +
      // touchMove across a pane, asserting `drop-target-*` then the split geometry.
      // File-tree→prompt attach (a different drop target) intentionally stays on
      // native DnD — a separate split-out per the DnD decision note §5/§8.
    },
  )
})
