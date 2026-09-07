// A real headless Chromium over a hand-authored DOM fixture, not a duck-typed `Page`:
// every rail-oracle export asserts through `@playwright/test` matchers, whose `expectTypes`
// guard rejects anything that is not an actual Locator/Page instance.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "playwright-core"
import {
  expectNavigatorSidebar,
  expectNavigatorSidebarAbsent,
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

function sessionRowHtml(opts: { id: string; title: string; time?: string }): string {
  const { id, title, time = "10:00 AM" } = opts
  return `
    <div data-testid="rail-sidebar-session-row" data-session-id="${id}">
      <span data-slot="navigation-row-glyph"></span>
      <span data-slot="session-navigation-title">${title}</span>
      <span data-slot="session-navigation-time">${time}</span>
    </div>`
}

describe("expectRailRowVisible — row appears without a reload, at the claimed index", () => {
  test("healthy: a row present with no reload becomes visible", async () => {
    await page.setContent(`<body>${sessionRowHtml({ id: "s1", title: "Refactor rail oracle" })}</body>`)
    await expect(expectRailRowVisible({ page, sessionId: "s1", timeout: 500 })).resolves.toBeDefined()
  })

  // timeout 300ms: the failure is deterministic absence, not a race.
  test("broken: row for the target session never renders", async () => {
    await page.setContent(`<body>${sessionRowHtml({ id: "unrelated-session", title: "Unrelated" })}</body>`)
    await expect(expectRailRowVisible({ page, sessionId: "s1", timeout: 300 })).rejects.toThrow(/never became visible without a reload/)
  })

  test("broken: row visible but at the wrong index (position claim fails independently of presence)", async () => {
    const rows = [
      sessionRowHtml({ id: "other", title: "Other" }),
      sessionRowHtml({ id: "s1", title: "Target" }),
    ].join("")
    await page.setContent(`<body>${rows}</body>`)
    await expect(expectRailRowVisible({ page, sessionId: "s1", index: 0, timeout: 300 })).rejects.toThrow(
      /a different row occupies it/,
    )
  })
})

describe("expectRailTitleSettled — title leaves the create-time placeholder", () => {
  test("healthy: a real (non-placeholder) title resolves immediately", async () => {
    await page.setContent(`<body>${sessionRowHtml({ id: "s1", title: "Refactor rail oracle module" })}</body>`)
    await expect(expectRailTitleSettled({ page, sessionId: "s1", timeout: 500 })).resolves.toBe(
      "Refactor rail oracle module",
    )
  })

  test('broken: title stuck at the create-time placeholder "New Session" never settles', async () => {
    await page.setContent(`<body>${sessionRowHtml({ id: "s1", title: "New Session" })}</body>`)
    await expect(expectRailTitleSettled({ page, sessionId: "s1", timeout: 300 })).rejects.toThrow(
      /still the create-time placeholder "New Session"/,
    )
  })

  // Covered separately so a PLACEHOLDER_TITLE regex that matched only "New Session" fails here.
  test('broken: title stuck at the alternate placeholder "Untitled session" never settles', async () => {
    await page.setContent(`<body>${sessionRowHtml({ id: "s1", title: "Untitled session" })}</body>`)
    await expect(expectRailTitleSettled({ page, sessionId: "s1", timeout: 300 })).rejects.toThrow(
      /still the create-time placeholder "Untitled session"/,
    )
  })
})

describe("expectRailRowMovesToTop — the re-prompted row reaches index 0", () => {
  test("healthy: the re-prompted row sits at index 0", async () => {
    const rows = [
      sessionRowHtml({ id: "target", title: "Re-prompted" }),
      sessionRowHtml({ id: "s2", title: "Older 1" }),
      sessionRowHtml({ id: "s3", title: "Older 2" }),
    ].join("")
    await page.setContent(`<body>${rows}</body>`)
    await expect(expectRailRowMovesToTop({ page, sessionId: "target", timeout: 500 })).resolves.toBeUndefined()
  })

  test("broken: the re-prompted row is still buried at index 5", async () => {
    const olderRows = Array.from({ length: 5 }, (_, i) => sessionRowHtml({ id: `s${i}`, title: `Older ${i}` })).join("")
    const rows = olderRows + sessionRowHtml({ id: "target", title: "Re-prompted" })
    await page.setContent(`<body>${rows}</body>`)
    await expect(expectRailRowMovesToTop({ page, sessionId: "target", timeout: 300 })).rejects.toThrow(
      /a different row still outranks it/,
    )
  })
})

describe("expectRailRowUnique — exactly one row per session id", () => {
  test("healthy: exactly one row renders for the session id", async () => {
    await page.setContent(`<body>${sessionRowHtml({ id: "s1", title: "Solo row" })}</body>`)
    await expect(expectRailRowUnique({ page, sessionId: "s1", timeout: 500 })).resolves.toBeUndefined()
  })

  test("broken: two rows share the same session id", async () => {
    const rows = sessionRowHtml({ id: "s1", title: "Project copy" }) + sessionRowHtml({ id: "s1", title: "Workspace copy" })
    await page.setContent(`<body>${rows}</body>`)
    await expect(expectRailRowUnique({ page, sessionId: "s1", timeout: 300 })).rejects.toThrow(
      /expected exactly one rail row for session "s1"/,
    )
  })
})

/** A row for `expectRailStatus`: title and time are positioned so `dotX < titleX` is
 * measurable, and the glyph column starts empty so the idle-mount precondition holds. */
function statusRowHtml(id: string): string {
  // Every child is position:absolute, so the row needs an explicit height; a zero-area
  // row reads as hidden to `toBeVisible`.
  return `
    <div data-testid="rail-sidebar-session-row" data-session-id="${id}" style="height:24px; width:300px;">
      <span data-slot="navigation-row-glyph" style="position:absolute; left:0; top:0; width:16px; height:16px;"></span>
      <span data-slot="session-navigation-title" style="position:absolute; left:41px; top:0;">Status row</span>
      <span data-slot="session-navigation-time" style="position:absolute; left:200px; top:0;">10:32 AM</span>
    </div>`
}

describe("expectRailStatus — idle -> working -> done on an unfocused row, dot placement", () => {
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

  // `driveWorking` does nothing, so the working-dot assertion fails, not the idle precondition.
  test("broken: driveWorking never produces a dot — the working assertion times out", async () => {
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

  // 8000ms, over bun:test's 5000ms default: `expectRailStatus`'s glyph-containment
  // assertion is the one check in that function that does not forward the caller's
  // `timeout`, so it polls on Playwright's own default and a caller cannot speed it up.
  // Below 8000ms this test fails on the bun timeout while that assertion is still
  // legitimately polling.
  test(
    "broken: dot renders on working but outside the glyph column (orphaned dot)",
    async () => {
      await page.setContent(`<body>${statusRowHtml("s1")}</body>`)
      const driveWorking = () =>
        page.evaluate(() => {
          const row = document.querySelector('[data-testid="rail-sidebar-session-row"]')!
          const dot = document.createElement("span")
          dot.setAttribute("data-sidebar-status", "working")
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

/** A rail plus a navigator sidebar per rail-oracle.ts's sidebar contract. `selected`
 * chooses which tab carries `aria-selected="true"`; `dataTab` is the aside's own attribute
 * and defaults to the selected tab. */
function navigatorHtml(opts: {
  selected?: "files" | "changes" | "processes" | null
  dataTab?: string
  extraSelected?: "files" | "changes" | "processes"
  order?: string[]
  insideRail?: boolean
}): string {
  const selected = opts.selected === undefined ? "changes" : opts.selected
  const order = opts.order ?? ["files", "changes", "processes"]
  const tabs = order
    .map((tab) => {
      const on = tab === selected || tab === opts.extraSelected
      return `<button role="tab" data-tab="${tab}" aria-selected="${on ? "true" : "false"}" style="width:60px;height:24px">${tab}</button>`
    })
    .join("")
  const aside = `<aside data-testid="navigator-sidebar" data-tab="${opts.dataTab ?? selected ?? ""}" style="width:240px;height:400px"><div role="tablist">${tabs}</div></aside>`
  const rail = opts.insideRail
    ? `<div data-testid="rail-sidebar" style="width:260px;height:400px">${aside}</div>`
    : `<div data-testid="rail-sidebar" style="width:260px;height:400px"></div>${aside}`
  return `<div style="display:flex">${rail}</div>`
}

describe("expectNavigatorSidebar — one sidebar beside the rail, three ordered tabs, one selected", () => {
  test("healthy: rail plus sidebar with Changes selected resolves, and the tab claim matches", async () => {
    await page.setContent(`<body>${navigatorHtml({ selected: "changes" })}</body>`)
    await expect(expectNavigatorSidebar({ page, tab: "changes", timeout: 500 })).resolves.toBeDefined()
  })

  test("broken: no sidebar mounted at all", async () => {
    await page.setContent(`<body><div data-testid="rail-sidebar" style="width:260px;height:400px"></div></body>`)
    await expect(expectNavigatorSidebar({ page, timeout: 300 })).rejects.toThrow(/expected exactly one navigator sidebar/)
  })

  test("broken: the sidebar mounted inside the rail instead of beside it", async () => {
    await page.setContent(`<body>${navigatorHtml({ insideRail: true })}</body>`)
    await expect(expectNavigatorSidebar({ page, timeout: 300 })).rejects.toThrow(/nested inside the rail/)
  })

  test("broken: tabs render out of order", async () => {
    await page.setContent(`<body>${navigatorHtml({ order: ["changes", "files", "processes"] })}</body>`)
    await expect(expectNavigatorSidebar({ page, timeout: 300 })).rejects.toThrow(/out of order/)
  })

  test("broken: two tabs selected at once", async () => {
    await page.setContent(`<body>${navigatorHtml({ selected: "changes", extraSelected: "files" })}</body>`)
    await expect(expectNavigatorSidebar({ page, timeout: 300 })).rejects.toThrow(/exactly one selected tab/)
  })

  test("broken: the aside's data-tab disagrees with the selected tab", async () => {
    await page.setContent(`<body>${navigatorHtml({ selected: "changes", dataTab: "files" })}</body>`)
    await expect(expectNavigatorSidebar({ page, timeout: 300 })).rejects.toThrow(/data-tab disagrees/)
  })

  test("broken: a different tab is selected than the one claimed", async () => {
    await page.setContent(`<body>${navigatorHtml({ selected: "files" })}</body>`)
    await expect(expectNavigatorSidebar({ page, tab: "changes", timeout: 300 })).rejects.toThrow(
      /expected the "changes" navigator tab to be selected/,
    )
  })
})

describe("expectNavigatorSidebarAbsent — classic placement mounts no sidebar", () => {
  test("healthy: only the rail is mounted", async () => {
    await page.setContent(`<body><div data-testid="rail-sidebar" style="width:260px;height:400px"></div></body>`)
    await expect(expectNavigatorSidebarAbsent({ page, timeout: 500 })).resolves.toBeUndefined()
  })

  test("broken: a sidebar is still mounted", async () => {
    await page.setContent(`<body>${navigatorHtml({})}</body>`)
    await expect(expectNavigatorSidebarAbsent({ page, timeout: 300 })).rejects.toThrow(/placement forbids one/)
  })
})
