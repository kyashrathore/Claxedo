// Mutation tests for `surface-parity.ts`. A real headless Chromium page drives a
// hand-authored fixture, because Playwright's matchers only accept real Locators.
//
// `closeSidebar`/`openSidebar` click and wait for a mount, so the fixture carries an inline
// script that toggles `display` on click, standing in for the `<Show>` gate that mounts the
// compact switcher only while the sidebar is un-pinned.
//
// `expectSurfaceParity` is checked for equal and unequal statuses; `expectSurfaceStatus`
// shares the equality logic and is checked once for its one difference (no round trip).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "playwright-core"
import {
  expectSurfaceParity,
  expectSurfaceStatus,
  closeSidebar,
  activeSwitcherContentId,
  focusSwitcherTab,
  type SurfaceStatus,
} from "./surface-parity"

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
 * A rail row, a `sidebar-toggle` button, a compact-switcher tab correlated to the row by
 * title, and a "Show Sidebar" button (plain text suffices for `getByRole`). An "idle"
 * status omits the dot entirely, as the real DOM does.
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
      // header note that this is "also the ONLY way [data-testid="compact-switcher"]
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

describe("expectSurfaceParity — sidebar/switcher status equality across a round trip", () => {
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

  // Fails on the first equality (switcher vs expected), before the cross-surface check.
  test('broken: rail "working" vs switcher "done" fails', async () => {
    await page.setContent(`<body>${parityFixtureHtml({ railStatus: "working", switcherStatus: "done" })}</body>`)
    await expect(expectSurfaceParity({ page, sessionId: SESSION_ID, expected: "working" })).rejects.toThrow(
      /data-switcher-status="done" but expected "working"/,
    )
  })

  test('healthy: equal rail/switcher status at "done" also passes', async () => {
    await page.setContent(`<body>${parityFixtureHtml({ railStatus: "done", switcherStatus: "done" })}</body>`)
    await expect(expectSurfaceParity({ page, sessionId: SESSION_ID, expected: "done" })).resolves.toMatchObject({
      sidebarStatus: "done",
      switcherStatus: "done",
    })
  })

  // Both dots agree with each other but not with `expected`; a bare cross-check would pass.
  test('broken: rail and switcher agree ("permission") but neither matches the expected "working"', async () => {
    await page.setContent(`<body>${parityFixtureHtml({ railStatus: "permission", switcherStatus: "permission" })}</body>`)
    await expect(expectSurfaceParity({ page, sessionId: SESSION_ID, expected: "working" })).rejects.toThrow(
      /data-sidebar-status="permission", expected "working" before the sidebar was touched/,
    )
  })
})

describe("focusSwitcherTab", () => {
  test("waits for the debounced tab selection to commit", async () => {
    await page.setContent(`<body>
      <div data-testid="compact-switcher">
        <div data-testid="compact-switcher-tab">
          <div data-slot="workbench-tab">
            <button type="button" data-testid="switcher-title-button"><span data-testid="switcher-title">${TITLE}</span></button>
          </div>
        </div>
      </div>
      <script>
        document.querySelector('[data-testid="compact-switcher-tab"]').addEventListener('click', function () {
          setTimeout(function () {
            document.querySelector('[data-slot="workbench-tab"]').setAttribute('data-selected', 'true')
          }, 50)
        })
      </script>
    </body>`)

    await focusSwitcherTab(page, TITLE)
    expect(await page.locator('[data-slot="workbench-tab"]').getAttribute("data-selected")).toBe("true")
  })

  test("uses stable content identity when multiple tabs share a title", async () => {
    await page.setContent(`<body>
      <div data-testid="compact-switcher">
        <div data-testid="compact-switcher-tab" data-content-id="old-draft">
          <div data-slot="workbench-tab">
            <button type="button" data-testid="switcher-title-button"><span data-testid="switcher-title">New Session</span></button>
          </div>
        </div>
        <div data-testid="compact-switcher-tab" data-content-id="current-draft">
          <div data-slot="workbench-tab" data-selected="true">
            <button type="button" data-testid="switcher-title-button"><span data-testid="switcher-title">New Session</span></button>
          </div>
        </div>
      </div>
      <script>
        document.querySelectorAll('[data-testid="compact-switcher-tab"]').forEach(function (tab) {
          tab.addEventListener('click', function () {
            document.querySelectorAll('[data-slot="workbench-tab"]').forEach(function (node) {
              node.removeAttribute('data-selected')
            })
            tab.querySelector('[data-slot="workbench-tab"]').setAttribute('data-selected', 'true')
          })
        })
      </script>
    </body>`)

    const contentId = await activeSwitcherContentId(page)
    expect(contentId).toBe("current-draft")
    await focusSwitcherTab(page, { contentId, title: "New Session" })
    expect(
      await page.locator('[data-content-id="current-draft"] [data-slot="workbench-tab"]').getAttribute("data-selected"),
    ).toBe("true")
  })
})

describe("expectSurfaceStatus (no sidebar round trip)", () => {
  // `closeSidebar` runs once here; `expectSurfaceStatus` never remounts the tab.
  test("healthy: equal status on an already-mounted tab passes", async () => {
    await page.setContent(`<body>${parityFixtureHtml({ railStatus: "working", switcherStatus: "working" })}</body>`)
    await closeSidebar(page)
    await expect(expectSurfaceStatus({ page, sessionId: SESSION_ID, expected: "working" })).resolves.toMatchObject({
      sidebarStatus: "working",
      switcherStatus: "working",
    })
  })

  test('broken: rail "working" vs switcher "done" on an already-mounted tab fails', async () => {
    await page.setContent(`<body>${parityFixtureHtml({ railStatus: "working", switcherStatus: "done" })}</body>`)
    await closeSidebar(page)
    await expect(expectSurfaceStatus({ page, sessionId: SESSION_ID, expected: "working" })).rejects.toThrow(
      /data-switcher-status="done" but expected "working"/,
    )
  })
})
