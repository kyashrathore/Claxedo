// TEMP probe (read-only): one-shot dump of the live transcript's row DOM, so
// the rapid-switch overlay probe's intra-timeline overlap check is built on the
// real structure instead of a guess at which nodes are rows.
import { chromium } from "@playwright/test"

import { frameSamplingLaunchArgs } from "../src/frame-sampler"
import { fixtureFor } from "../src/browser/fixtures"
import { installMockApi } from "../src/browser/mock-api"
import { installSeedState, sessionPath } from "../src/browser/state"
import { launchTo } from "../src/browser/actions/common"
import { monitorPage } from "../src/browser/page-validation"
import { startApp, stopApp } from "../src/browser/environment"
import { waitForTranscript } from "../src/browser/actions/session"
import { environmentProfile } from "../src/environment-profile"
import { seedForScenario } from "../src/seed"

const SCENARIO = "session-switch-workspace" as const
const app = await startApp()
const fixture = fixtureFor(SCENARIO, seedForScenario(SCENARIO))
const browser = await chromium.launch({ headless: true, args: frameSamplingLaunchArgs, timeout: 30_000 })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
await installMockApi(page, app, fixture, monitorPage(page), environmentProfile("unthrottled"))
await installSeedState(page, app, fixture)
const home = fixture.sessions[0]!
await launchTo(page, app, sessionPath(home, home.id))
await waitForTranscript(page, fixture, home.id, home.title)
await page.waitForTimeout(1_500)

const dump = await page.evaluate(() => {
  const timeline = Array.from(document.querySelectorAll<HTMLElement>("[data-session-timeline-session-id]"))
    .find((node) => getComputedStyle(node).visibility !== "hidden" && node.getBoundingClientRect().height > 100)
  if (!timeline) return { error: "no visible timeline" }
  const withId = Array.from(timeline.querySelectorAll<HTMLElement>("[data-message-id]"))
  const byId = new Map<string, number>()
  for (const node of withId) {
    const id = node.getAttribute("data-message-id") ?? "?"
    byId.set(id, (byId.get(id) ?? 0) + 1)
  }
  const duplicated = [...byId].filter(([, count]) => count > 1)
  const sample = withId.slice(0, 8).map((node) => {
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    const chain: string[] = []
    let cursor: HTMLElement | null = node
    for (let i = 0; cursor && i < 5; i++) {
      chain.unshift(`${cursor.tagName.toLowerCase()}${cursor.getAttribute("data-slot") ? `[${cursor.getAttribute("data-slot")}]` : ""}`)
      cursor = cursor.parentElement
    }
    return {
      id: node.getAttribute("data-message-id"),
      tag: node.tagName.toLowerCase(),
      position: style.position,
      transform: style.transform,
      rect: { top: Math.round(rect.top), h: Math.round(rect.height) },
      chain: chain.join(" > "),
      nestedWithId: node.querySelectorAll("[data-message-id]").length,
    }
  })
  const scroller = timeline.querySelector<HTMLElement>("[data-slot='session-timeline-scroll']")
  return {
    timelineSession: timeline.getAttribute("data-session-timeline-session-id"),
    rowCount: timeline.getAttribute("data-session-timeline-row-count"),
    nodesWithMessageId: withId.length,
    distinctMessageIds: byId.size,
    duplicatedIds: duplicated.slice(0, 5),
    scrollerPresent: !!scroller,
    scrollTop: scroller?.scrollTop,
    sample,
  }
})
console.log(JSON.stringify(dump, null, 2))
await browser.close()
await stopApp(app)
