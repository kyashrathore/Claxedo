/** One-off: measure computed styles of the spike's slotted header chain. */
import { fixtureFor, installMockApi, installSeedState, launchTo, monitorPage, openReviewSurface, sessionPath, startApp, waitForTranscript } from "./browser-runner"
import { environmentProfile } from "./environment-profile"
import { seedForScenario } from "./seed"
import { chromium } from "@playwright/test"

const scenario = "heavy-workspace-close" as const
const app = await startApp()
const fixture = fixtureFor(scenario, seedForScenario(scenario))
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
await installMockApi(page, app, fixture, monitorPage(page), environmentProfile("unthrottled"))
await installSeedState(page, app, fixture)
const session = fixture.sessions[0]!
await launchTo(page, app, sessionPath(fixture, session.id))
await waitForTranscript(page, fixture, session.id, session.title)
await openReviewSurface(page, fixture, { settle: "frame" })
await page.waitForTimeout(2500)
const report = await page.evaluate(() => {
  const pick = (element: Element | null | undefined, props: string[]) => {
    if (!element) return null
    const style = getComputedStyle(element)
    const rect = (element as HTMLElement).getBoundingClientRect()
    return {
      rect: { x: Math.round(rect.x), w: Math.round(rect.width), h: Math.round(rect.height) },
      ...Object.fromEntries(props.map((prop) => [prop, style.getPropertyValue(prop)])),
    }
  }
  const host = document.querySelector('[data-slot="session-review-header-host"]')
  const chain = {
    slotWrapper: pick(host?.parentElement, ["display", "width"]),
    host: pick(host, ["display", "width"]),
    portal: pick(host?.firstElementChild, ["display", "width"]),
    accordion: pick(host?.querySelector('[data-component="accordion"]'), ["display", "width"]),
    item: pick(host?.querySelector('[data-slot="accordion-item"]'), ["display", "width"]),
    header: pick(host?.querySelector('[data-slot="accordion-header"]'), ["display", "width"]),
    trigger: pick(host?.querySelector('[data-slot="accordion-trigger"]'), [
      "display", "width", "height", "padding", "border-top-width", "border-color", "background-color", "justify-content",
    ]),
    content: pick(host?.querySelector('[data-slot="session-review-trigger-content"]'), ["display", "justify-content", "width", "gap"]),
    info: pick(host?.querySelector('[data-slot="session-review-file-info"]'), ["display", "flex-grow"]),
    actions: pick(host?.querySelector('[data-slot="session-review-trigger-actions"]'), ["display", "gap"]),
    controls: pick(host?.querySelector('[data-slot="session-review-row-controls"]'), ["display"]),
    copy: pick(host?.querySelector('[data-slot="session-review-copy-button"]'), ["display", "opacity"]),
    chevron: pick(host?.querySelector('[data-slot="session-review-diff-chevron"]'), ["display", "transform", "color"]),
  }
  const shadowHeader = document.querySelector("[data-review-file]")?.shadowRoot?.querySelector("[data-diffs-header]")
  return {
    chain,
    shadowHeader: shadowHeader ? pick(shadowHeader, ["display", "width", "position"]) : null,
    slotDisplay: shadowHeader?.querySelector("slot") ? getComputedStyle(shadowHeader.querySelector("slot")!).display : null,
  }
})
console.log(JSON.stringify(report, null, 1))
await browser.close()
process.exit(0)
