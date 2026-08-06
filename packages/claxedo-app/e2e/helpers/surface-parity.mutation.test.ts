// Mutation verification for `e2e/helpers/surface-parity.ts` — the open Phase 1 checkbox in
// `docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md`: "Each oracle is
// mutation-verified: breaking the product behaviour turns it red."
//
// Same rationale as the two sibling `*.mutation.test.ts` files for using a REAL (headless)
// Chromium page via `playwright-core` rather than a hand-rolled `Page`/`Locator` object —
// `expectSurfaceParity` drives real `Locator.click()` and polling `expect(...).toBeVisible()`
// assertions that need the actual Playwright driver channel. See `rail-oracle.mutation.test.ts`'s
// header for the full citation trail.
//
// UNLIKE the other two oracle files, `expectSurfaceParity`/`closeSidebar`/`openSidebar` are
// INTERACTIVE: they click real buttons and wait for a mount/unmount to happen as a result
// (surface-parity.ts:149-159's `closeSidebar` explicitly "waits for the switcher root to
// actually mount, not just for the toggle click to resolve"). A static DOM snapshot can't
// stand in for that — this file's fixture ships a small inline `<script>` that toggles
// `display` on click, reproducing exactly the two `<Show>` gates
// `workbench-shell-header.tsx:107` and the sidebar-toggle/Show-Sidebar pair document (see
// surface-parity.ts's own header, lines 33-45), so `closeSidebar`/`openSidebar` are
// exercising the SAME wait-for-mount behavior they exercise against the real app, just
// against a hand-authored toggle instead of Solid's reactivity.
//
// Scope: this file mutation-verifies `expectSurfaceParity`, the function actually used by
// every real B9 call site (surface-parity.ts:185-235) and the one named in the task brief's
// exact scenario ("data-sidebar-status=\"working\" with data-switcher-status=\"done\" must
// FAIL expectSurfaceParity; equal values pass"). `expectSurfaceStatus` (the
// non-remounting transition variant, lines 258-288) is the SAME equality logic reused
// verbatim against an already-mounted tab — mutation-verified too, once, for that specific
// difference (no sidebar round trip), rather than repeating every equal/unequal case.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "playwright-core"
import { expectSurfaceParity, expectSurfaceStatus, closeSidebar, type SurfaceStatus } from "./surface-parity"

let browser: Browser
let page: Page

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
  await browser.close()
})

beforeEach(async () => {
  page = await browser.newPage()
})

afterEach(async () => {
  await page.close()
})

const SESSION_ID = "s1"
const TITLE = "Refactor surface parity oracle"

/**
 * Builds the interactive fixture surface-parity.ts's SELECTORS require
 * (surface-parity.ts:65-74): a rail row with `data-sidebar-status` (absent == "idle", per
 * `readRailRow`'s own comment, lines 86-94), a `sidebar-toggle` button, a compact-switcher
 * tab correlated to the row ONLY by matching title text (the file header's documented
 * limitation — `switcherTabForTitle`, lines 108-131 — since no session id is ever stamped
 * onto a switcher tab in the real DOM either), and a "Show Sidebar" button matched by
 * `getByRole("button", { name: "Show Sidebar" })` (surface-parity.ts:169) — plain visible
 * text is sufficient for that accessible-name computation, no `aria-label` needed.
 *
 * `railStatus`/`switcherStatus` independently omit their dot entirely when "idle" —
 * mirroring the real app's own `<Show when={status !== "idle"}>` gate this file's header
 * cites (surface-parity.ts:86-94, :133-136), so "idle" is never simulated by an explicit
 * `data-*-status="idle"` attribute that the real DOM would never produce.
 */
function parityFixtureHtml(opts: { railStatus: SurfaceStatus; switcherStatus: SurfaceStatus }): string {
  const { railStatus, switcherStatus } = opts
  const railDot = railStatus === "idle" ? "" : `<span data-sidebar-status="${railStatus}"></span>`
  const switcherDot = switcherStatus === "idle" ? "" : `<span data-switcher-status="${switcherStatus}"></span>`
  return `
    <button data-testid="sidebar-toggle">Toggle</button>
    <button id="show-sidebar-btn">Show Sidebar</button>
    <div data-testid="rail-sidebar-session-row" data-session-id="${SESSION_ID}">
      <span data-slot="session-navigation-title">${TITLE}</span>
      ${railDot}
    </div>
    <div data-testid="compact-switcher" style="display:none;">
      <div data-testid="compact-switcher-tab">
        <span data-testid="switcher-title">${TITLE}</span>
        ${switcherDot}
      </div>
    </div>
    <script>
      // Stands in for workbench-shell-header.tsx:107's "<Show when={!sidebarPinned()}>"
      // gate around BOTH the sidebar-toggle button and CompactSwitcher — clicking one
      // toggle mounts/unmounts the other's visibility, matching surface-parity.ts's own
      // header note that this is "also the ONLY way [data-testid=\"compact-switcher\"]
      // enters the DOM."
      (function () {
        var toggle = document.querySelector('[data-testid="sidebar-toggle"]');
        var showBtn = document.getElementById('show-sidebar-btn');
        var switcher = document.querySelector('[data-testid="compact-switcher"]');
        showBtn.style.display = 'none';
        toggle.addEventListener('click', function () {
          toggle.style.display = 'none';
          switcher.style.display = 'block';
          showBtn.style.display = 'inline-block';
        });
        showBtn.addEventListener('click', function () {
          showBtn.style.display = 'none';
          switcher.style.display = 'none';
          toggle.style.display = 'inline-block';
        });
      })();
    </script>`
}

describe("expectSurfaceParity (B9) — surface-parity.ts:185-235", () => {
  test("healthy: equal rail/switcher status passes and survives the sidebar round trip", async () => {
    await page.setContent(`<body>${parityFixtureHtml({ railStatus: "working", switcherStatus: "working" })}</body>`)
    const evidence = await expectSurfaceParity({ page, sessionId: SESSION_ID, expected: "working" })
    expect(evidence).toEqual({
      sessionId: SESSION_ID,
      title: TITLE,
      sidebarStatus: "working",
      switcherStatus: "working",
    })
  })

  // The task's exact scenario: 'data-sidebar-status="working" with
  // data-switcher-status="done" must FAIL expectSurfaceParity'. This is the literal claim
  // compact-switcher.tsx:28-29's "kept in sync with NavigationStatusDot" comment makes and
  // surface-parity.ts's header says "a claim with no test behind it before this file" —
  // this test is that test. Caught on the FIRST of the two equality assertions
  // (surface-parity.ts:217-220: switcherStatus vs `expected`), before the cross-surface
  // DISAGREE check even runs, because `expected: "working"` matches the rail but not the
  // switcher — proving the oracle fails as soon as EITHER surface diverges from ground
  // truth, not only when both surfaces disagree with each other but happen to agree with
  // nothing.
  test('broken: rail "working" vs switcher "done" fails — the two surfaces have drifted apart', async () => {
    await page.setContent(`<body>${parityFixtureHtml({ railStatus: "working", switcherStatus: "done" })}</body>`)
    await expect(expectSurfaceParity({ page, sessionId: SESSION_ID, expected: "working" })).rejects.toThrow(
      /data-switcher-status="done" but expected "working"/,
    )
  })

  // The complementary direction: BOTH surfaces move together to a non-"working" status —
  // proves the oracle isn't just "always require working", it tracks whatever `expected`
  // the caller asserts.
  test('healthy: equal rail/switcher status at "done" also passes', async () => {
    await page.setContent(`<body>${parityFixtureHtml({ railStatus: "done", switcherStatus: "done" })}</body>`)
    await expect(expectSurfaceParity({ page, sessionId: SESSION_ID, expected: "done" })).resolves.toMatchObject({
      sidebarStatus: "done",
      switcherStatus: "done",
    })
  })

  // A defect that freezes BOTH dots at the same WRONG value would slip past a bare
  // cross-equality check (switcherStatus === sidebarStatus) while still being broken —
  // surface-parity.ts:213-216 names this explicitly: "so a defect that freezes BOTH dots
  // at the same wrong value cannot hide behind a bare cross-equality check." Both surfaces
  // agree with EACH OTHER here ("permission" == "permission") but neither matches the
  // ground-truth `expected` ("working"), and this must still fail.
  test('broken: rail and switcher AGREE with each other ("permission") but neither matches ground truth ("working")', async () => {
    await page.setContent(`<body>${parityFixtureHtml({ railStatus: "permission", switcherStatus: "permission" })}</body>`)
    await expect(expectSurfaceParity({ page, sessionId: SESSION_ID, expected: "working" })).rejects.toThrow(
      /data-sidebar-status="permission", expected "working" BEFORE the sidebar was touched/,
    )
  })
})

describe("expectSurfaceStatus — surface-parity.ts:258-288 (no sidebar round trip)", () => {
  // expectSurfaceStatus assumes closeSidebar has already run and the tab is already
  // mounted (its own doc comment, lines 244-245: "call closeSidebar(page) before the
  // first expectSurfaceStatus") — this is the "transition experiment" shape the file
  // header describes for probing whether an ALREADY-MOUNTED compact-switcher tab tracks a
  // status change, as opposed to `expectSurfaceParity`'s fresh-mount-every-call shape.
  test("healthy: equal status on an already-mounted tab passes", async () => {
    await page.setContent(`<body>${parityFixtureHtml({ railStatus: "working", switcherStatus: "working" })}</body>`)
    await closeSidebar(page)
    await expect(expectSurfaceStatus({ page, sessionId: SESSION_ID, expected: "working" })).resolves.toMatchObject({
      sidebarStatus: "working",
      switcherStatus: "working",
    })
  })

  // Same drift shape as expectSurfaceParity's negative case, but on a tab that was never
  // remounted for this check — the shape defect #12 would actually produce on the
  // compact-switcher if the freeze-at-mount suspicion (surface-parity.ts:14-31) turns out
  // to be real: a tab that mounted "idle" and never grew a dot despite the rail moving on.
  test('broken: rail "working" vs switcher "done" on an already-mounted tab fails', async () => {
    await page.setContent(`<body>${parityFixtureHtml({ railStatus: "working", switcherStatus: "done" })}</body>`)
    await closeSidebar(page)
    await expect(expectSurfaceStatus({ page, sessionId: SESSION_ID, expected: "working" })).rejects.toThrow(
      /data-switcher-status="done" but expected "working"/,
    )
  })
})
