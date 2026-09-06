// TEMP probe: stand up the built spike app + mock, open Review, dump DOM facts.
import { chromium } from "@playwright/test"
import { fixtureFor } from "../src/browser/fixtures"
import { installMockApi } from "../src/browser/mock-api"
import { installSeedState, sessionPath } from "../src/browser/state"
import { launchTo } from "../src/browser/actions/common"
import { monitorPage } from "../src/browser/page-validation"
import { openReviewSurface } from "../src/browser/actions/review"
import { startApp } from "../src/browser/environment"
import { waitForTranscript } from "../src/browser/actions/session"
import { environmentProfile } from "../src/environment-profile"
import { seedForScenario } from "../src/seed"

/**
 * The debug handle the review code-view library publishes on `window`.
 *
 * A description of a third-party surface, not a contract the app owns: only
 * the members this probe reads are named, and everything the library may or
 * may not provide is optional. Previously each of the four reads below
 * re-declared its own slice of it and cast `window` to reach it.
 */
type ReviewCodeView = {
  getRenderedItems: () => ReviewRenderedItem[]
  getItem: (id: string) => unknown
  render: (force: boolean) => void
}

type ReviewRenderedItem = {
  id: string
  item: { fileDiff?: ReviewFileDiff; collapsed?: boolean }
  instance: ReviewCodeViewInstance
}

type ReviewFileDiff = {
  name?: string
  additionLines?: string[]
  deletionLines?: string[]
  hunks?: unknown[]
}

type ReviewCodeViewInstance = {
  height?: number
  options?: { collapsed?: boolean; disableFileHeader?: boolean }
  fileDiff?: unknown
  hunksRenderer?: { renderDiff: (fileDiff: unknown, range: { start: number; end: number }) => unknown }
  fileContainer?: Element
  enabled?: boolean
  isSetup?: boolean
}

declare global {
  interface Window {
    __reviewCodeView?: ReviewCodeView
  }
}

const scenario = "heavy-workspace-close" as const
const app = await startApp()
const fixture = fixtureFor(scenario, seedForScenario(scenario))
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
page.on("console", (message) => {
  if (message.type() === "error" || message.type() === "warning") console.log("[page]", message.type(), message.text().slice(0, 400))
})
page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 600)))
await installMockApi(page, app, fixture, monitorPage(page), environmentProfile("unthrottled"))
await installSeedState(page, app, fixture)
const session = fixture.sessions[0]
await launchTo(page, app, sessionPath(fixture, session.id))
await waitForTranscript(page, fixture, session.id, session.title)
await openReviewSurface(page, fixture, { settle: "frame" })
await page.waitForTimeout(5000)

const tree = await page.evaluate(() => {
  const scrollSlot = document.querySelector("[data-slot='session-review-scroll']")
  const rootEl = scrollSlot?.firstElementChild
  const height = (el: Element) => (el instanceof HTMLElement ? el.offsetHeight : undefined)
  const outline = (el: Element, depth: number): string[] => {
    if (depth > 3) return []
    const style = el.getAttribute("style") ?? ""
    const line = `${"  ".repeat(depth)}<${el.tagName.toLowerCase()}> h=${height(el)} kids=${el.children.length} style="${style.slice(0, 120)}"`
    return [line, ...Array.from(el.children).slice(0, 4).flatMap((c) => outline(c, depth + 1))]
  }
  const first = document.querySelector("diffs-container")
  const shadowFirstChild = first?.shadowRoot?.firstElementChild
  return {
    rootOutline: rootEl ? outline(rootEl, 0).join("\n") : "(no root)",
    shadowLen: first?.shadowRoot?.innerHTML.length,
    shadowHead: first?.shadowRoot?.innerHTML.slice(0, 300),
    shadowFirstChildH: shadowFirstChild ? height(shadowFirstChild) : undefined,
  }
})
console.log(tree.rootOutline)
console.log("shadowLen:", tree.shadowLen, "shadowFirstChildH:", tree.shadowFirstChildH)
console.log("shadowHead:", tree.shadowHead)

const state = await page.evaluate(() => {
  const cv = window.__reviewCodeView
  if (!cv) return { hook: false }
  const rendered = cv.getRenderedItems()
  const first = rendered[0]
  const fd = first?.item.fileDiff
  const inst = first?.instance
  return {
    hook: true,
    renderedCount: rendered.length,
    firstId: first?.id,
    collapsedFlag: first?.item.collapsed,
    fdName: fd?.name,
    fdAdditionLines: fd?.additionLines?.length,
    fdDeletionLines: fd?.deletionLines?.length,
    fdHunks: (fd?.hunks)?.length,
    instHeight: inst?.height,
    instCollapsed: inst?.options?.collapsed,
    instDisableHeader: inst?.options?.disableFileHeader,
  }
})
console.log("STATE:", JSON.stringify(state))

const renderProbe = await page.evaluate(() => {
  const cv = window.__reviewCodeView
  const inst = cv?.getRenderedItems()[0]?.instance
  if (!inst) return { ok: false }
  const renderer = inst.hunksRenderer
  let emptyResult: unknown = "n/a"
  try {
    emptyResult = renderer?.renderDiff(inst.fileDiff, { start: 0, end: 50 }) ?? null
  } catch (error) {
    emptyResult = "threw: " + String(error).slice(0, 200)
  }
  const summary = (value: unknown) => {
    if (value === null || value === undefined) return String(value)
    if (typeof value === "object") return Object.keys(value).join(",")
    if (typeof value === "string") return value.slice(0, 100)
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return String(value).slice(0, 100)
    }
    return `[${typeof value}]`
  }
  return {
    ok: true,
    hasRenderer: !!renderer,
    emptyResult: summary(emptyResult),
    fileContainer: !!inst.fileContainer,
    fileContainerTag: inst.fileContainer?.tagName,
    fileContainerChildCount: inst.fileContainer?.shadowRoot?.childElementCount ?? inst.fileContainer?.childElementCount,
    enabled: inst.enabled,
    isSetup: inst.isSetup,
  }
})
console.log("RENDER-PROBE:", JSON.stringify(renderProbe))

const kick = await page.evaluate(async () => {
  const cv = window.__reviewCodeView
  cv?.render(true)
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const container = document.querySelector("diffs-container")
  const first = container instanceof HTMLElement ? container : null
  const scrollerChild = document.querySelector("[data-slot='session-review-scroll']")?.firstElementChild
  const scroller = scrollerChild instanceof HTMLElement ? scrollerChild : null
  return {
    shadowLenAfterKick: container?.shadowRoot?.innerHTML.length,
    firstH: first?.offsetHeight,
    scrollerH: scroller?.offsetHeight,
    scrollerClientH: scroller?.clientHeight,
  }
})
console.log("KICK:", JSON.stringify(kick))

const facts = await page.evaluate(() => {
  const root = document.querySelector("[data-testid='review-pane-root']")
  const scrollSlot = document.querySelector("[data-slot='session-review-scroll']")
  const inner = scrollSlot?.firstElementChild
  const containers = document.querySelectorAll("diffs-container")
  const stamped = document.querySelectorAll("[data-review-file]")
  const first = containers[0]
  const triggers = document.querySelectorAll("[data-testid$='-trigger']")
  return {
    hasRoot: !!root,
    scrollSlotChildren: scrollSlot?.children.length,
    innerHTMLHead: inner?.innerHTML.slice(0, 600),
    containerCount: containers.length,
    stampedCount: stamped.length,
    firstOuterHead: first ? first.outerHTML.slice(0, 400) : null,
    firstLightChildren: first
      ? Array.from(first.children).map((c) => `${c.tagName}:${c instanceof HTMLElement ? c.dataset.testid ?? "" : ""}`)
      : null,
    firstShadow: !!first?.shadowRoot,
    firstRect: first ? JSON.parse(JSON.stringify(first.getBoundingClientRect())) : null,
    triggerCount: triggers.length,
    pending: !!document.querySelector("[data-testid='workspace-review-pending']"),
    bodyTextHasFile: document.body.innerText.includes("file-0.ts"),
  }
})
console.log(JSON.stringify(facts, null, 1))
await page.screenshot({ path: process.env.PROBE_SHOT ?? "/tmp/probe-codeview.png" })
await browser.close()
process.exit(0)
