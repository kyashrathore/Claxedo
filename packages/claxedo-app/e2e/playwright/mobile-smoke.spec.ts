/**
 * SPEC: Mobile viewport smoke (narrow-width shell contract)
 *
 * PURPOSE — the app ships one codebase for web + mobile, but per the responsive
 * audit (health 4/10) genuine mobile usability of the two signature
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
 *   `[data-testid="drop-target-<paneId>"]` / `[data-testid="pane-handle-<paneId>"]` /
 *     `[data-workbench-content][data-pane-id]` — the workbench drag-drop surfaces
 *     behavior 4 drives via touch, shared with `core-panes-split-tabs.spec.ts`'s
 *     mouse-driven coverage of the identical mechanism.
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
 *   4. Multipane split has a real touch equivalent, driven end to end via CDP
 *      `Input.dispatchTouchEvent` (real touch → PointerEvent synthesis, not a
 *      synthetic DOM event the engine could special-case). WP-C3 replaced native
 *      HTML5 DnD (never functional on touch) with a hand-rolled pointer-events
 *      engine — `workbench/pointer-drag.ts`'s `workbenchDrag` + `useDragSource`,
 *      adopted by the pane grip (`workbench.tsx`), the tab strip
 *      (`compact-switcher.tsx`), and sidebar rows (`navigation-row.tsx`); all
 *      three route through the SAME single drop zone (`workbench.tsx`'s
 *      `registerDropZone`), which is why dragging any of them onto a pane's edge
 *      commits the same `wb.split.split()` — there is no separate "reorder within
 *      a strip/list" mechanism, only "drop this content onto a pane edge" (see
 *      `reducers/split.ts`: dropping a pane's OWN content onto a sibling pane
 *      unbinds the source pane rather than deleting it, so a pane-grip drag reads
 *      as a rearrange even though it runs the identical split path a tab drag
 *      does). This test long-press-drags a background switcher tab onto a pane's
 *      edge (proving the tab-strip source), then a pane's own grip onto a
 *      sibling's edge (proving the pane-grip source), asserting the
 *      `drop-target-*` overlay mid-drag and the resulting pane geometry after
 *      `touchend` commits. UNOBSERVABLE at this spec's default phone viewport —
 *      below `BP_MD` (768, `workbench/collapse-projection.ts`) the workbench
 *      collapses to one full-bleed pane and hides the rest, so this one test
 *      widens its own viewport past the breakpoint (see the test body); every
 *      other scenario in this spec stays at the phone viewport the `mobile`
 *      project emulates. File-tree→prompt attach (a different drop target)
 *      intentionally stays on native DnD — out of scope here (DnD decision note
 *      §5/§8).
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
 *   test); sidebar-row (session list) touch drag onto a pane — the engine and drop
 *   zone are the SAME ones behavior 4 proves for the tab strip and pane grip
 *   (`sourceKind: "navigation-row"` in `pointer-drag.ts`, same single
 *   `registerDropZone`), and this spec's mock runtime seeds zero sidebar session
 *   rows, so there is nothing here to drag — not a gap, just an unexercised third
 *   caller of an already-proven mechanism; axe-core accessibility scanning at this
 *   viewport (`a11y-sweep.spec.ts` covers accessibility, at desktop viewport,
 *   separately).
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
  //
  // WAIT for the composer instead of probing it with a zero-wait `isVisible()`:
  // the app DOES render the composer for `/{slug}/session` at 390px (verified
  // with a standalone probe against the prebuilt preview: invisible at
  // `[data-claxedo]`-paint time, visible well within 15s — the session surface
  // is a lazy chunk), so the instant probe was racy-by-construction. Worse, its
  // fallback — `getByRole("button", { name: "New Session" }).first()` — is a
  // SUBSTRING role match that resolves to the sidebar row's "New session in
  // main" hover action, which lives inside the closed drawer OUTSIDE the 390px
  // viewport; Playwright then retries "element is outside of the viewport"
  // until the 60s test timeout. That fallback click was the entire failure
  // mode of behaviors 2 and 3, not any app regression.
  await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 15_000 })
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

/** Mocks the REAL terminal PTY create route (`/api/wr/pty`, not the stale
 * `/api/claxedo/pty` legacy path). Enough for a pane to mount and activate; the
 * websocket I/O is not modeled (not needed by this spec — only `core-terminal`
 * asserts terminal I/O). Verbatim copy of `core-panes-split-tabs.spec.ts`'s
 * `installPtyMock` — behavior 4's fixture needs the same second surface. */
function installPtyMock(page: Page) {
  let counter = 0
  return page.route("**/api/wr/pty**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === "POST" && /\/api\/wr\/pty$/.test(url.pathname)) {
      counter += 1
      const body = request.postDataJSON?.() as { title?: string } | undefined
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: `pty_test_${counter}`, title: body?.title ?? `Terminal ${counter}`, cwd: DIR }),
      })
      return
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "true" })
  })
}

/** Playwright's bundled Chromium reports `navigator.platform === "Win32"` in this
 * harness regardless of host OS (`core-panes-split-tabs.spec.ts` carries the same
 * finding) — resolve the modifier at runtime instead of trusting `process.platform`. */
async function modKey(page: Page): Promise<"Meta" | "Control"> {
  const isMac = await page.evaluate(() => /(Mac|iPod|iPhone|iPad)/.test(navigator.platform))
  return isMac ? "Meta" : "Control"
}

/** The compact switcher tab strip only renders while the sidebar is unpinned
 * (`workbench-shell-header.tsx`'s `<Show when={!sidebarPinned()}>`) — same gate
 * `core-panes-split-tabs.spec.ts` documents for its own switcher assertions. */
async function unpinSidebarForSwitcher(page: Page) {
  const mod = await modKey(page)
  await page.keyboard.press(`${mod}+b`)
  await expect(page.locator('[data-testid="compact-switcher"]')).toBeVisible({ timeout: 10_000 })
}

function backgroundTitleButtons(page: Page) {
  return page.locator('[data-testid="switcher-title-button"]:not([aria-current="page"])')
}

/** A rendered content slot bound to a live pane (`[data-pane-id]` present — a
 * stashed/unpaned content slot has none). */
function visiblePaneContents(page: Page) {
  return page.locator("[data-workbench-content][data-pane-id]")
}

/** Thin wrapper over CDP `Input.dispatchTouchEvent` — the primitive Playwright's
 * own `page.touchscreen` doesn't expose (it only offers a single-shot `tap()`, no
 * multi-step drag path). This drives Chromium's REAL touch →
 * `PointerEvent(pointerType:"touch")` synthesis pipeline — the same one a
 * physical touchscreen drives — not a synthetic DOM event our engine could
 * special-case; `useDragSource`'s `pointerdown` listener (`pointer-drag.ts`) is
 * what actually receives this input. `touchPoints: []` on `touchEnd` signals full
 * release (Puppeteer's own `Touchscreen.tap()` convention). CRITICAL: every
 * `touchStart`/`touchMove` touch point carries the SAME explicit `id` — without
 * it, Chromium's touch→pointer synthesis treats each dispatched point as a
 * DISTINCT touch, minting a NEW `pointerId` per event; `useDragSource`'s
 * `window.pointermove` listener guards on `event.pointerId !== pointerId`
 * (`pointer-drag.ts`), so a mismatched id makes every move after the initial
 * `pointerdown` silently no-op (verified empirically: the drop-target overlay
 * never appeared without this). */
async function openTouch(page: Page) {
  const client = await page.context().newCDPSession(page)
  const TOUCH_ID = 7
  return {
    async start(x: number, y: number) {
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: TOUCH_ID }] })
    },
    async move(x: number, y: number) {
      await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y, id: TOUCH_ID }] })
    },
    async end() {
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    },
    async detach() {
      await client.detach().catch(() => {})
    },
  }
}

/** Long-press-drags from `source` to a point on `targetBox`'s edge (`axis`/
 * `edgeFraction` pick which edge — e.g. `axis:"x", edgeFraction:0.94` lands near
 * the right edge, `axis:"y", edgeFraction:0.08` near the top). Holds still for
 * longer than the engine's `TOUCH_LONG_PRESS_MS` (250ms, `pointer-drag.ts`)
 * before moving at all — moving first reads as a scroll and ABORTS the drag
 * (`pointer-drag.ts`'s real-input fix, WP-C3a). Returns the open touch session so
 * the caller can assert mid-drag DOM state (the drop-target overlay) before
 * calling `.end()` to commit — mirroring a real finger: press, hold, drag, lift.
 *
 * PATH SHAPE IS LOAD-BEARING, not cosmetic. `useDragSource`'s drag sources
 * default their (non-grip) `touch-action` to the axis they must keep scrollable
 * pre-drag (`pan-x` for the horizontal tab strip) — Chromium's OWN compositor
 * keeps arbitrating that axis for native panning even mid-drag, and a pointer
 * path with real movement along the PERMITTED axis gets a native `pointercancel`
 * handed to the main thread regardless of our own `setPointerCapture()` call
 * (verified empirically: an initial diagonal jump toward the target reliably
 * cancelled a `touch-action:pan-x` tab drag; the SAME drop, reached via this
 * vertical-first path, never does). A tab strip always sits ABOVE every pane, so
 * a real finger's first movement leaving it is vertical anyway — this helper's
 * two-phase path (down, THEN across) matches that real gesture, not the other
 * way around. Many small steps, not one or two big jumps, for the same reason a
 * physical finger never teleports. */
async function touchLongPressDragTo(
  page: Page,
  source: { x: number; y: number },
  targetBox: { x: number; y: number; width: number; height: number },
  axis: "x" | "y",
  edgeFraction: number,
) {
  const touch = await openTouch(page)
  await touch.start(source.x, source.y)
  await page.waitForTimeout(400)
  const targetX = axis === "x" ? targetBox.x + targetBox.width * edgeFraction : targetBox.x + targetBox.width / 2
  const targetY = axis === "y" ? targetBox.y + targetBox.height * edgeFraction : targetBox.y + targetBox.height / 2
  const waypointX = source.x + 5
  const waypointY = targetBox.y + targetBox.height / 2
  const STEPS = 20
  const STEP_DELAY_MS = 16 // ~60fps, matching a real touch sample rate
  for (let i = 1; i <= STEPS; i++) {
    await touch.move(source.x + ((waypointX - source.x) * i) / STEPS, source.y + ((waypointY - source.y) * i) / STEPS)
    await page.waitForTimeout(STEP_DELAY_MS)
  }
  for (let i = 1; i <= STEPS; i++) {
    await touch.move(waypointX + ((targetX - waypointX) * i) / STEPS, waypointY + ((targetY - waypointY) * i) / STEPS)
    await page.waitForTimeout(STEP_DELAY_MS)
  }
  return touch
}

// `@core`, not `@happy`: this spec exists because "none of this is guarded by CI" (see
// PURPOSE above), and `@happy` is a dead pre-consolidation lane no CI job selects — so
// under `CLAXEDO_E2E_SUITE=core` the `mobile` Playwright project resolved to ZERO tests
// and the guard guarded nothing. It is Tier M (every route mocked, zero real network),
// 5 tests, so it belongs in the watched lane. The `mobile` project's `testMatch` still
// confines it to iPhone-13 emulation; the chromium project `testIgnore`s `mobile-*`, so
// it never also runs at desktop viewport. See the lane registry in `playwright.config.ts`.
test.describe("mobile smoke @core", () => {
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

    // Opener opens the drawer (scrim appears; opener stays mounted above the
    // drawer as a close toggle, mirroring the desktop sidebar button).
    await opener.click()
    await expect(scrim).toBeVisible({ timeout: 5_000 })
    await expect(opener).toBeVisible()
    await expect(opener).toHaveAttribute("aria-expanded", "true")

    const accountTrigger = page.getByTestId("rail-account-trigger")
    await expect(accountTrigger).toBeVisible()
    await accountTrigger.click()
    const accountMenu = page.getByRole("menu")
    await expect(accountMenu).toBeVisible()
    const menuBox = await accountMenu.boundingBox()
    expect(menuBox).not.toBeNull()
    expect(menuBox!.x).toBeGreaterThanOrEqual(0)
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    await page.keyboard.press("Escape")
    await expect(accountMenu).toHaveCount(0)

    // Tapping the scrim (right of the 280px drawer) closes it; the opener stays
    // visible and flips back to its collapsed state.
    await scrim.click({ position: { x: 340, y: 400 } })
    await expect(scrim).toHaveCount(0)
    await expect(opener).toBeVisible()
    await expect(opener).toHaveAttribute("aria-expanded", "false")
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

  test(
    "long-press-dragging a switcher tab, then a pane grip, splits the workbench via touch — behavior 4",
    async ({ page }) => {
      // ENGINE: shipped and UNIT-PROVEN. WP-C3 replaced native HTML5 DnD with a
      // hand-rolled pointer-events engine (mouse + touch + pen) —
      // `workbench/pointer-drag.ts` (`workbenchDrag` + `useDragSource`), adopted
      // by the pane grip (workbench.tsx), the tab strip (compact-switcher.tsx),
      // and sidebar rows (navigation-row.tsx). This test drives that engine with
      // REAL touch input (CDP `Input.dispatchTouchEvent`, see `openTouch`/
      // `touchLongPressDragTo` above) — Chromium's own touch → PointerEvent
      // synthesis, the same pipeline a physical touchscreen drives.
      //
      // TABLET-WIDTH OVERRIDE (this test only): split geometry is UNOBSERVABLE
      // below BP_MD (768, `workbench/collapse-projection.ts`) — the collapse
      // projection renders exactly one full-bleed pane and hides the rest at
      // phone width, so `drop-target-*` / split rects can't be asserted on the
      // `mobile` project's iPhone-13 viewport (390px). Every OTHER scenario in
      // this spec stays at the phone viewport this project emulates; only this
      // one widens past the breakpoint, keeping `hasTouch`/`isMobile` from the
      // `mobile` project's own device descriptor (`playwright.config.ts`).
      await page.setViewportSize({ width: 1024, height: 900 })

      await seedOneProject(page, DIR)
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await installPtyMock(page)
      await openWorkbench(page, DIR)
      await unpinSidebarForSwitcher(page)
      await expect(page.locator('[data-testid="session-content"][data-session-id="new"]')).toBeVisible({
        timeout: 20_000,
      })

      // Multi-surface fixture: a second background tab (a mocked terminal),
      // matching `core-panes-split-tabs.spec.ts`'s `buildDraftPlusTerminalSplit`
      // setup — 2 switcher tabs, 1 visible pane, nothing split yet. Creating the
      // terminal focuses it, backgrounding the draft (mirrors the desktop spec's
      // own ordering).
      // The header's per-agent quick-launch buttons are gone; one "New Terminal"
      // button opens the creator, whose tile turns that same surface into the
      // terminal in place — so this still ends at 2 switcher tabs.
      await page.locator('[data-testid="workspace-scope-new-terminal"]').first().click()
      const launchers = page.locator('[data-component="terminal-new-launchers"]')
      await expect(launchers).toBeVisible({ timeout: 20_000 })
      await launchers.locator('[data-slot="terminal-launcher"][data-launcher-id="claude"]').first().click()
      await expect(page.locator('[data-testid="terminal-pane"]')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[data-testid="compact-switcher-tab"]')).toHaveCount(2, { timeout: 10_000 })

      // --- Part 1: long-press-drag the background (draft) switcher tab onto the
      //     active (terminal) pane's right edge — the exact mechanism
      //     `core-panes-split-tabs.spec.ts` behavior 1 proves with a mouse.
      const backgroundTab = backgroundTitleButtons(page).first()
      const tabBox = await backgroundTab.boundingBox()
      const terminalPane = page
        .locator('[data-workbench-content][data-pane-id]')
        .filter({ has: page.locator('[data-testid="terminal-pane"]') })
      const terminalPaneId = await terminalPane.getAttribute("data-pane-id")
      const terminalPaneBox = await terminalPane.boundingBox()
      expect(tabBox).not.toBeNull()
      expect(terminalPaneId).not.toBeNull()
      expect(terminalPaneBox).not.toBeNull()
      if (!tabBox || !terminalPaneId || !terminalPaneBox) return

      const tabDrag = await touchLongPressDragTo(
        page,
        { x: tabBox.x + tabBox.width / 2, y: tabBox.y + tabBox.height / 2 },
        terminalPaneBox,
        "x",
        0.94, // near the right edge — `computeDropEdge` resolves to "right"
      )
      // Drop-target overlay proves the touch-driven pointer stream reached the
      // drop zone's hit-test (`workbench.tsx`'s `registerDropZone.onMove`), not
      // just the source's own `pointerdown`.
      await expect(page.locator(`[data-testid="drop-target-${terminalPaneId}"]`)).toBeVisible({ timeout: 5_000 })
      await tabDrag.end()
      await tabDrag.detach()

      // Resulting geometry: the split actually committed via `touchend`.
      await expect(page.locator('[data-testid="workbench-divider"]')).toBeVisible({ timeout: 10_000 })
      await expect(visiblePaneContents(page)).toHaveCount(2, { timeout: 10_000 })

      // --- Part 2: long-press-drag the DRAFT pane's own grip onto the terminal
      //     pane's top edge. Re-query the draft's pane after the split above —
      //     it now lives in a freshly-created pane, not its pre-split slot.
      const draftPane = page
        .locator('[data-workbench-content][data-pane-id]')
        .filter({ has: page.locator('[data-testid="session-content"][data-session-id="new"]') })
      const draftPaneId = await draftPane.getAttribute("data-pane-id")
      expect(draftPaneId).not.toBeNull()
      if (!draftPaneId) return

      const grip = page.locator(`[data-testid="pane-handle-${draftPaneId}"]`)
      const gripBox = await grip.boundingBox()
      const terminalPaneBoxBeforeGripDrag = await terminalPane.boundingBox()
      const draftBoxBeforeGripDrag = await draftPane.boundingBox()
      expect(gripBox).not.toBeNull()
      expect(terminalPaneBoxBeforeGripDrag).not.toBeNull()
      if (!gripBox || !terminalPaneBoxBeforeGripDrag) return

      const gripDrag = await touchLongPressDragTo(
        page,
        { x: gripBox.x + gripBox.width / 2, y: gripBox.y + gripBox.height / 2 },
        terminalPaneBoxBeforeGripDrag,
        "y",
        0.08, // near the top edge — `computeDropEdge` resolves to "top"
      )
      await expect(page.locator(`[data-testid="drop-target-${terminalPaneId}"]`)).toBeVisible({ timeout: 5_000 })
      await gripDrag.end()
      await gripDrag.detach()

      // Resulting geometry: the dragged pane's OWN slot is now empty (its
      // content moved to a freshly-inserted pane beside the terminal —
      // `reducers/split.ts`'s `split()` unbinds the source pane rather than
      // deleting it), and the draft content's on-screen box has genuinely moved
      // (not just a re-painted attribute) — both only true if the touch-driven
      // pointer stream actually drove the commit, not merely the drop overlay.
      await expect(page.locator(`[data-testid="pane-${draftPaneId}"] [data-testid="empty"]`)).toBeVisible({
        timeout: 10_000,
      })
      const draftContentAfter = page
        .locator('[data-workbench-content][data-pane-id]')
        .filter({ has: page.locator('[data-testid="session-content"][data-session-id="new"]') })
      await expect(draftContentAfter).toHaveCount(1)
      const draftBoxAfterGripDrag = await draftContentAfter.boundingBox()
      expect(draftBoxAfterGripDrag).not.toBeNull()
      if (draftBoxBeforeGripDrag && draftBoxAfterGripDrag) {
        expect(
          draftBoxAfterGripDrag.x !== draftBoxBeforeGripDrag.x ||
            draftBoxAfterGripDrag.y !== draftBoxBeforeGripDrag.y ||
            draftBoxAfterGripDrag.width !== draftBoxBeforeGripDrag.width ||
            draftBoxAfterGripDrag.height !== draftBoxBeforeGripDrag.height,
        ).toBe(true)
      }
    },
  )
})
