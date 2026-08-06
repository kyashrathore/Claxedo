// Mutation verification for `e2e/helpers/rail-oracle.ts` — the open Phase 1 checkbox in
// `docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md`: "Each oracle is
// mutation-verified: breaking the product behaviour turns it red."
//
// WHY a real (headless) Chromium page instead of a hand-rolled duck-typed `Page` object:
// every export in rail-oracle.ts calls `expect(locator).toBeVisible()` /
// `.toHaveAttribute()` / `.toHaveCount()` / `.toHaveText()` from `@playwright/test`. Those
// matchers dispatch through `Locator._expect(...)`, which talks to the real Playwright
// driver channel (verified 2026-08-06 by reading
// `node_modules/.bun/playwright@1.61.1/node_modules/playwright/lib/matchers/expect.js:12354-12364`
// — `toBeVisible` is a thin wrapper over `locator._expect("to.be.visible", ...)`, and
// `expectTypes` at line 11632 rejects anything that is not an actual Locator/Page
// instance). A plain object satisfying only "the methods this file happens to call" cannot
// answer `_expect`'s channel protocol, so the assertions would throw a type error before
// ever reaching the DOM logic under test — proving nothing about rail-oracle.ts's actual
// polling/selector logic. `playwright-core`'s `chromium.launch()` + `page.setContent(...)`
// gives a REAL Page/Locator (the exact same class: `playwright/test`'s own `test.d.ts:18`
// imports `Page`/`Locator` from `'playwright-core'`, so there is no type-compatibility gap
// either) driving a FAKE, hand-authored DOM fixture instead of the real app. That is the
// "fake page" this file's task description means: fake product surface, real Playwright.
// Confirmed working standalone (no `playwright test` runner, no test-info context) via a
// throwaway smoke test 2026-08-06 before writing any of the fixtures below.
//
// DOM contract mirrored exactly from rail-oracle.ts's own header comment (lines 8-14) —
// selector strings are copied from `SELECTORS`, never re-derived, so a selector typo here
// cannot silently pass by accident.
//
// Every `describe` block below asserts BOTH directions: a healthy fixture the oracle must
// accept, and a broken fixture — built to reproduce a NAMED defect or open issue's exact
// shape — the oracle must reject. A block with only the healthy half proves the oracle
// doesn't crash on good input, which is not what "mutation-verified" means.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "playwright-core"
import {
  expectRailRowMovesToTop,
  expectRailRowUnique,
  expectRailRowVisible,
  expectRailStatus,
  expectRailTitleSettled,
} from "./rail-oracle"

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

/** A minimal session row matching rail-oracle.ts's DOM contract (lines 9-13). No CSS
 * positioning here — geometry is geometry-oracle.ts's job, not this file's; the empty
 * `navigation-row-glyph` span exists only so `expectRailStatus`'s glyph-containment check
 * (line 196) has somewhere to look, and is otherwise inert for the other four exports. */
function sessionRowHtml(opts: { id: string; title: string; time?: string }): string {
  const { id, title, time = "10:00 AM" } = opts
  return `
    <div data-testid="rail-sidebar-session-row" data-session-id="${id}">
      <span data-slot="navigation-row-glyph"></span>
      <span data-slot="session-navigation-title">${title}</span>
      <span data-slot="session-navigation-time">${time}</span>
    </div>`
}

describe("expectRailRowVisible (B1) — rail-oracle.ts:53-74", () => {
  test("healthy: a row present with no reload becomes visible", async () => {
    await page.setContent(`<body>${sessionRowHtml({ id: "s1", title: "Refactor rail oracle" })}</body>`)
    await expect(expectRailRowVisible({ page, sessionId: "s1", timeout: 500 })).resolves.toBeDefined()
  })

  // Defects 1/2/7's shared observable shape (comment at line 63): the row for the session
  // the app just created simply never appears — no `data-session-id="s1"` node exists at
  // all, standing in for a `file://` API base, a dropped rail invalidation, or a workspace
  // that never opened its event stream. `timeout: 300` (not the 15s default) keeps this
  // negative-direction proof fast — the failure mode here is deterministic absence, not a
  // race the test needs 15s of margin to observe.
  test("broken: row for the target session never renders (defects 1/2/7 shape) times out", async () => {
    await page.setContent(`<body>${sessionRowHtml({ id: "unrelated-session", title: "Unrelated" })}</body>`)
    await expect(expectRailRowVisible({ page, sessionId: "s1", timeout: 300 })).rejects.toThrow(/never became visible without a reload/)
  })

  test("broken: row visible but at the wrong index (position claim fails independently of presence)", async () => {
    const rows = [
      sessionRowHtml({ id: "other", title: "Other" }),
      sessionRowHtml({ id: "s1", title: "Target" }),
    ].join("")
    await page.setContent(`<body>${rows}</body>`)
    // s1 IS visible (proves presence alone isn't what's being asserted here) but sits at
    // index 1, not the claimed index 0.
    await expect(expectRailRowVisible({ page, sessionId: "s1", index: 0, timeout: 300 })).rejects.toThrow(
      /a different row occupies it/,
    )
  })
})

describe("expectRailTitleSettled (B3) — rail-oracle.ts:88-112, defect 8", () => {
  test("healthy: a real (non-placeholder) title resolves immediately", async () => {
    await page.setContent(`<body>${sessionRowHtml({ id: "s1", title: "Refactor rail oracle module" })}</body>`)
    await expect(expectRailTitleSettled({ page, sessionId: "s1", timeout: 500 })).resolves.toBe(
      "Refactor rail oracle module",
    )
  })

  // Defect 8: `session.updated` was dropped at the runtime bridge, so the row was stuck on
  // its create-time placeholder forever. This fixture reproduces that terminal state
  // directly — the title text never leaves "New Session" — rather than simulating the
  // drop mechanically, since the oracle only observes the DOM, not the transport.
  test('broken: title stuck at the create-time placeholder "New Session" (defect 8) never settles', async () => {
    await page.setContent(`<body>${sessionRowHtml({ id: "s1", title: "New Session" })}</body>`)
    await expect(expectRailTitleSettled({ page, sessionId: "s1", timeout: 300 })).rejects.toThrow(
      /still the create-time placeholder "New Session"/,
    )
  })

  // The "Untitled session" placeholder is the second half of the PLACEHOLDER_TITLE regex
  // (rail-oracle.ts:40) — covered separately because a regex bug that matched only "New
  // Session" (e.g. an unescaped `|` precedence slip) would pass the test above and still
  // let this placeholder through undetected in production.
  test('broken: title stuck at the alternate placeholder "Untitled session" never settles', async () => {
    await page.setContent(`<body>${sessionRowHtml({ id: "s1", title: "Untitled session" })}</body>`)
    await expect(expectRailTitleSettled({ page, sessionId: "s1", timeout: 300 })).rejects.toThrow(
      /still the create-time placeholder "Untitled session"/,
    )
  })
})

describe("expectRailRowMovesToTop (B5) — rail-oracle.ts:121-127, defect 10", () => {
  test("healthy: the re-prompted row sits at index 0", async () => {
    const rows = [
      sessionRowHtml({ id: "target", title: "Re-prompted" }),
      sessionRowHtml({ id: "s2", title: "Older 1" }),
      sessionRowHtml({ id: "s3", title: "Older 2" }),
    ].join("")
    await page.setContent(`<body>${rows}</body>`)
    await expect(expectRailRowMovesToTop({ page, sessionId: "target", timeout: 500 })).resolves.toBeUndefined()
  })

  // Defect 10 verbatim (plan line 178, oracle comment line 125): "a 30-second-old row sat
  // at position 6 under rows 12-29 minutes older" because reconcile rewrote `updatedAt` in
  // place with no re-sort. Five older rows ahead of the target reproduces that shape (index
  // 5, matching the task's exact scenario) without needing a real reconcile pass.
  test("broken: the re-prompted row is still buried at index 5 (defect 10 — reconcile never re-sorted)", async () => {
    const olderRows = Array.from({ length: 5 }, (_, i) => sessionRowHtml({ id: `s${i}`, title: `Older ${i}` })).join("")
    const rows = olderRows + sessionRowHtml({ id: "target", title: "Re-prompted" })
    await page.setContent(`<body>${rows}</body>`)
    await expect(expectRailRowMovesToTop({ page, sessionId: "target", timeout: 300 })).rejects.toThrow(
      /a different row still outranks it/,
    )
  })
})

describe("expectRailRowUnique (B6) — rail-oracle.ts:137-143, open issue #14", () => {
  test("healthy: exactly one row renders for the session id", async () => {
    await page.setContent(`<body>${sessionRowHtml({ id: "s1", title: "Solo row" })}</body>`)
    await expect(expectRailRowUnique({ page, sessionId: "s1", timeout: 500 })).resolves.toBeUndefined()
  })

  // Open issue #14 (plan lines 187-192): a `session.lifecycle` frame carrying
  // `info.workspaceID` renders the SAME session id twice — once under a project section,
  // once under a workspace section. Two rows sharing `data-session-id="s1"` is that shape
  // exactly, independent of which DOM subtree each copy happens to live under.
  test("broken: two rows share the same session id (issue #14 — workspaceID double-render)", async () => {
    const rows = sessionRowHtml({ id: "s1", title: "Project copy" }) + sessionRowHtml({ id: "s1", title: "Workspace copy" })
    await page.setContent(`<body>${rows}</body>`)
    await expect(expectRailRowUnique({ page, sessionId: "s1", timeout: 300 })).rejects.toThrow(
      /expected exactly one rail row for session "s1"/,
    )
  })
})

/** A row shaped for `expectRailStatus`: title and time are explicitly positioned (needed
 * for the oracle's own `dotX < titleX` check, line 204-209) and the glyph column starts
 * EMPTY — `expectRailStatus`'s defect-12 mount-while-idle precondition (lines 181-187)
 * requires the dot to be absent before `driveWorking` runs, in both the healthy and
 * broken fixtures below, or the oracle fails on the precondition instead of the thing this
 * test is trying to isolate. */
function statusRowHtml(id: string): string {
  // The row itself gets an explicit height: every child below is `position:absolute`
  // (deliberately, so its `left` is measured from the viewport/ICB and stays comparable to
  // the plain pixel values geometry-oracle.ts's header cites — "terminal titles at x=65,
  // session titles at x=41"), which removes each child from normal flow. A block element
  // whose entire content is out-of-flow collapses to height:0, and Playwright's
  // `toBeVisible` treats a zero-area box as hidden — caught 2026-08-06 when this fixture's
  // `expect(row).toBeVisible()` failed with "Received: hidden" before this height was
  // added, on EVERY variant (healthy included), which is exactly the kind of fixture bug
  // this mutation suite exists to not have (a broken fixture, not a broken oracle).
  return `
    <div data-testid="rail-sidebar-session-row" data-session-id="${id}" style="height:24px; width:300px;">
      <span data-slot="navigation-row-glyph" style="position:absolute; left:0; top:0; width:16px; height:16px;"></span>
      <span data-slot="session-navigation-title" style="position:absolute; left:41px; top:0;">Status row</span>
      <span data-slot="session-navigation-time" style="position:absolute; left:200px; top:0;">10:32 AM</span>
    </div>`
}

describe("expectRailStatus (B7) — rail-oracle.ts:170-222, defects 11 & 12", () => {
  test("healthy: idle -> working -> done, dot inside the glyph column and left of the title", async () => {
    await page.setContent(`<body>${statusRowHtml("s1")}</body>`)
    const driveWorking = () =>
      page.evaluate(() => {
        const glyph = document.querySelector('[data-slot="navigation-row-glyph"]')!
        const dot = document.createElement("span")
        dot.setAttribute("data-sidebar-status", "working")
        dot.style.cssText = "position:absolute; left:20px; top:0; width:6px; height:6px;"
        glyph.appendChild(dot)
      })
    const driveDone = () =>
      page.evaluate(() => {
        document.querySelector("[data-sidebar-status]")!.setAttribute("data-sidebar-status", "done")
      })
    await expect(
      expectRailStatus({ page, sessionId: "s1", driveWorking, driveDone, timeout: 1000 }),
    ).resolves.toBeDefined()
  })

  // Defect 12's exact observable failure per the task brief: "a dot that never appears
  // must fail expectRailStatus." `driveWorking` here is the transport doing nothing —
  // standing in for the Solid early-return that froze the glyph at its mount-time idle
  // status, so a transition to "working" never produces a dot at all. The oracle's own
  // idle-mount precondition (statusRowHtml's empty glyph) still holds, so this fails on
  // exactly the assertion defect 12 broke (line 191-194), not on the precondition.
  test("broken: driveWorking never produces a dot (defect 12 shape) — the working assertion times out", async () => {
    await page.setContent(`<body>${statusRowHtml("s1")}</body>`)
    await expect(
      expectRailStatus({
        page,
        sessionId: "s1",
        driveWorking: () => {},
        driveDone: () => {},
        timeout: 300,
      }),
    ).rejects.toThrow(/never showed a "working" status dot/)
  })

  // Defect 11's other half: the dot DOES appear on "working", but orphaned outside the
  // glyph column (rail-oracle.ts:196-198 names this "x=11, left of the workspace icon").
  // Placing the dot as a sibling of the glyph span, not a child of it, reproduces that
  // exact orphaning — this must fail on the glyph-containment assertion specifically, one
  // line before the oracle would otherwise reach the dotX/titleX comparison.
  //
  // 8000ms test timeout, not the file's usual short-and-fast pattern: rail-oracle.ts:196-198's
  // glyph-containment `expect(...).toHaveCount(1)` is the ONE assertion in `expectRailStatus`
  // that does not forward the caller's `timeout` option (unlike every other assertion in the
  // function, which all take `{timeout}`) — verified by re-reading the source, not assumed,
  // after this test first failed by hitting bun:test's OWN 5000ms default test-timeout while
  // Playwright's assertion was still legitimately polling on its unconfigurable default. This
  // is a real, load-bearing gap in the oracle (a caller cannot speed up this one check), so
  // the honest fix is to give bun:test more room, not to shorten what's being proven.
  test(
    "broken: dot renders on working but outside the glyph column (defect 11 — orphaned dot)",
    async () => {
      await page.setContent(`<body>${statusRowHtml("s1")}</body>`)
      const driveWorking = () =>
        page.evaluate(() => {
          const row = document.querySelector('[data-testid="rail-sidebar-session-row"]')!
          const dot = document.createElement("span")
          dot.setAttribute("data-sidebar-status", "working")
          // Appended to the ROW, not the `[data-slot="navigation-row-glyph"]` span inside
          // it — the orphaned placement defect 11 fixed.
          dot.style.cssText = "position:absolute; left:11px; top:0; width:6px; height:6px;"
          row.appendChild(dot)
        })
      await expect(
        expectRailStatus({
          page,
          sessionId: "s1",
          driveWorking,
          driveDone: () => {},
          timeout: 300,
        }),
      ).rejects.toThrow(/is not inside the left \[data-slot="navigation-row-glyph"\] column/)
    },
    8000,
  )
})
