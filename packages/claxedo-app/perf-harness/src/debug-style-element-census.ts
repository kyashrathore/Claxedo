// TEMP probe (read-only diagnosis): WHERE are the elements that one
// whole-document style recalculation pays for?
//
// `debug-style-floor-attribution.ts` prices the floor (ms, and µs per element)
// but treats the document as one undifferentiated pile of elements. This probe
// answers the complementary question: which subtrees hold that pile, and which
// of them are already display-locked (`content-visibility: hidden`, the only
// mechanism that removes a subtree from a whole-document pass — `contain` does
// not).
//
// Two passes, both on the same settled page:
//
//   census   walk the document (and shadow roots) and print every subtree whose
//            element count clears a threshold, indented by depth, annotated
//            with its lock state (own + inherited content-visibility, display,
//            inert, aria-hidden) and its identity (testid / data-slot / role).
//            "locked" here means: a whole-document style pass skips it.
//
//   charge   for each big UNLOCKED owner, a paired drift-immune measurement:
//            time the floor, apply `content-visibility: hidden` to that subtree
//            root, time it again, restore. The delta is the ms that subtree is
//            actually charging the pass — i.e. the prize for locking it, if
//            locking it is correct. Paired and interleaved so a busy box
//            cancels out.
//
// It mutates the live page's styles, so it is a measurement tool only: it never
// runs alongside a reported benchmark, and the page is thrown away afterwards.
//
// Run:
//   cd packages/claxedo-app/perf-harness
//   CLAXEDO_PERF_SKIP_BUILD=1 CLAXEDO_PERF_MOCK_PORT=<baked> bun src/debug-style-element-census.ts
import { chromium, type Page } from "@playwright/test"

import { frameSamplingLaunchArgs } from "./frame-sampler"
import {
  fixtureFor,
  installMockApi,
  installSeedState,
  launchTo,
  monitorPage,
  openReviewSurface,
  sessionPath,
  startApp,
  stopApp,
  waitForTranscript,
} from "./browser-runner"
import { environmentProfile } from "./environment-profile"
import { settleBeforeNextInteraction } from "./isolated-interaction"
import { seedForScenario } from "./seed"

const SCENARIO = (process.env.CLAXEDO_CENSUS_SCENARIO ?? "workspace-interactions") as "workspace-interactions" | "session-switch-workspace"
const round = (value: number) => Math.round(value * 100) / 100

type CensusNode = {
  path: string
  depth: number
  label: string
  elements: number
  ownContentVisibility: string
  locked: boolean
  lockedBy: string
  display: string
  visibility: string
  inert: boolean
  ariaHidden: string
  offscreen: boolean
  rect: string
}

const installMeter = async (page: Page) =>
  await page.evaluate(() => {
    // Same floor meter as debug-style-floor-attribution: write an inherited
    // custom property on <html> (marks the whole document) and read a computed
    // colour (flushes style, not layout).
    const time = (samples = 7): { min: number; median: number } => {
      const values: number[] = []
      for (let index = 0; index < samples; index++) {
        document.documentElement.style.setProperty("--claxedo-census-probe", String(index))
        const started = performance.now()
        void getComputedStyle(document.body).color
        values.push(performance.now() - started)
      }
      document.documentElement.style.removeProperty("--claxedo-census-probe")
      void getComputedStyle(document.body).color
      values.sort((a, b) => a - b)
      return { min: values[0]!, median: values[Math.floor(values.length / 2)]! }
    }

    const rootsOf = (node: Element): Array<Element | ShadowRoot> => {
      const shadow = (node as HTMLElement).shadowRoot
      return shadow ? [node, shadow] : [node]
    }

    const countDeep = (node: Element): number => {
      let total = 1
      for (const child of node.children) total += countDeep(child)
      const shadow = (node as HTMLElement).shadowRoot
      if (shadow) for (const child of shadow.children) total += countDeep(child)
      return total
    }

    const count = () => {
      let total = document.querySelectorAll("*").length
      for (const host of document.querySelectorAll("*")) {
        const shadow = (host as HTMLElement).shadowRoot
        if (shadow) total += shadow.querySelectorAll("*").length
      }
      return total
    }

    const labelOf = (node: Element) => {
      const el = node as HTMLElement
      const testid = el.dataset.testid
      const slot = el.dataset.slot
      const component = el.dataset.component
      const bits = [
        node.tagName.toLowerCase(),
        node.id ? `#${node.id}` : "",
        testid ? `[testid=${testid}]` : "",
        slot ? `[slot=${slot}]` : "",
        component && component !== slot ? `[cmp=${component}]` : "",
        el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : "",
      ].filter(Boolean)
      if (bits.length <= 1) {
        const cls = (typeof node.className === "string" ? node.className : "").split(/\s+/).filter(Boolean).slice(0, 3).join(".")
        if (cls) bits.push(`.${cls}`)
      }
      return bits.join("")
    }

    // A stable address for a node so the charge pass can find it again after
    // the census pass returned plain JSON.
    const pathOf = (node: Element): string => {
      const segments: string[] = []
      let current: Node | null = node
      while (current && current !== document.documentElement) {
        const parent: Node | null = current.parentNode
        if (!parent) break
        if (parent instanceof ShadowRoot) {
          const index = Array.prototype.indexOf.call(parent.children, current)
          segments.unshift(`#shadow>${index}`)
          current = parent.host
          continue
        }
        const index = Array.prototype.indexOf.call((parent as Element).children ?? [], current)
        segments.unshift(String(index))
        current = parent
      }
      return segments.join("/")
    }

    const nodeAt = (path: string): Element | undefined => {
      let current: Element = document.documentElement
      if (path === "") return current
      for (const segment of path.split("/")) {
        if (segment.startsWith("#shadow>")) {
          const shadow = (current as HTMLElement).shadowRoot
          if (!shadow) return undefined
          const next = shadow.children[Number(segment.slice("#shadow>".length))]
          if (!next) return undefined
          current = next
          continue
        }
        const next = current.children[Number(segment)]
        if (!next) return undefined
        current = next
      }
      return current
    }

    const census = (threshold: number): CensusNodeShape[] => {
      const out: CensusNodeShape[] = []
      const walk = (node: Element, depth: number, inheritedLock: string) => {
        const total = countDeep(node)
        if (total < threshold) return
        const style = getComputedStyle(node)
        const own = style.getPropertyValue("content-visibility") || ""
        const rect = node.getBoundingClientRect()
        // A subtree is removed from the whole-document pass when it (or an
        // ancestor) is display-locked. `content-visibility: auto` locks only
        // while off-viewport; report it separately rather than claiming it.
        const lockedBy = inheritedLock
          || (own === "hidden" ? labelOf(node) : "")
          || (style.display === "none" ? `${labelOf(node)} display:none` : "")
        out.push({
          path: pathOf(node),
          depth,
          label: labelOf(node),
          elements: total,
          ownContentVisibility: own,
          locked: Boolean(lockedBy),
          lockedBy,
          display: style.display,
          visibility: style.visibility,
          inert: (node as HTMLElement).inert === true,
          ariaHidden: node.getAttribute("aria-hidden") ?? "",
          offscreen: rect.width === 0 || rect.height === 0 || rect.bottom <= 0 || rect.right <= 0
            || rect.top >= innerHeight || rect.left >= innerWidth,
          rect: `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)}`,
        })
        for (const root of rootsOf(node)) {
          for (const child of root.children) walk(child, depth + 1, lockedBy)
        }
      }
      walk(document.documentElement, 0, "")
      return out
    }

    // Paired, interleaved: A/B/A/B so slow-box drift cancels instead of
    // landing entirely on one side.
    const charge = (path: string, rounds: number) => {
      const node = nodeAt(path) as HTMLElement | undefined
      if (!node) return undefined
      const elements = countDeep(node)
      const previous = node.style.getPropertyValue("content-visibility")
      const withSubtree: number[] = []
      const lockedTimes: number[] = []
      for (let round = 0; round < rounds; round++) {
        node.style.setProperty("content-visibility", previous || "visible")
        withSubtree.push(time(5).min)
        node.style.setProperty("content-visibility", "hidden")
        lockedTimes.push(time(5).min)
      }
      if (previous) node.style.setProperty("content-visibility", previous)
      else node.style.removeProperty("content-visibility")
      const best = (values: number[]) => values.sort((a, b) => a - b)[0]!
      const a = best(withSubtree)
      const b = best(lockedTimes)
      return { withSubtree: a, locked: b, delta: a - b, elements }
    }

    // Windowed lists (review rows, transcript rows) render a window that is
    // deliberately larger than the scrollport so scrolling has runway. Every
    // materialized row outside the scrollport is a live element paying the
    // whole-document pass while showing the user nothing — the exact shape
    // `content-visibility` is for. Report the split and price it.
    const occupancy = (scrollSelector: string, rowSelector: string, rounds: number) => {
      const scroller = document.querySelector<HTMLElement>(scrollSelector)
      if (!scroller) return undefined
      // `rowSelector` names the row container; its element children are the
      // rows. Discovering rows as children rather than by their own selector
      // keeps this working across list implementations (accordion items,
      // virtual rows, plain <li>) without hard-coding each one's markup.
      const container = rowSelector ? scroller.querySelector<HTMLElement>(rowSelector) : scroller
      if (!container) return undefined
      const rows = Array.from(container.children) as HTMLElement[]
      if (rows.length === 0) return undefined
      const port = scroller.getBoundingClientRect()
      const onscreen: HTMLElement[] = []
      const offscreen: HTMLElement[] = []
      let onElements = 0
      let offElements = 0
      for (const row of rows) {
        const rect = row.getBoundingClientRect()
        const intersects = rect.bottom > port.top && rect.top < port.bottom
        const elements = countDeep(row)
        if (intersects) {
          onscreen.push(row)
          onElements += elements
        } else {
          offscreen.push(row)
          offElements += elements
        }
      }
      const priceLocking = (mode: string) => {
        const before: number[] = []
        const after: number[] = []
        for (let round = 0; round < rounds; round++) {
          for (const row of offscreen) row.style.removeProperty("content-visibility")
          before.push(time(5).min)
          for (const row of offscreen) row.style.setProperty("content-visibility", mode)
          after.push(time(5).min)
        }
        for (const row of offscreen) row.style.removeProperty("content-visibility")
        const best = (values: number[]) => values.sort((a, b) => a - b)[0]!
        return { before: best(before), after: best(after) }
      }
      return {
        rows: rows.length,
        onscreenRows: onscreen.length,
        offscreenRows: offscreen.length,
        onElements,
        offElements,
        scrollHeight: scroller.scrollHeight,
        portHeight: Math.round(port.height),
        hiddenPrice: priceLocking("hidden"),
        autoPrice: priceLocking("auto"),
      }
    }

    // The ceiling for this whole lane: inside one scroller, find the MAXIMAL
    // subtree roots that lie entirely outside the scrollport (nothing of them
    // is on screen), and price locking exactly those. Maximal = never descend
    // into a root already selected, so elements are counted once. Whatever this
    // returns is the most any display-locking change to this surface can win.
    const subfold = (scrollSelector: string, rounds: number) => {
      const scroller = document.querySelector<HTMLElement>(scrollSelector)
      if (!scroller) return undefined
      const port = scroller.getBoundingClientRect()
      const roots: HTMLElement[] = []
      let outElements = 0
      let inElements = 0
      const walk = (node: Element) => {
        const rect = node.getBoundingClientRect()
        // Zero-box nodes (display:contents, empty wrappers) carry no position
        // of their own — descend rather than judging them by a collapsed rect.
        const hasBox = rect.width > 0 || rect.height > 0
        if (hasBox && (rect.bottom <= port.top || rect.top >= port.bottom)) {
          roots.push(node as HTMLElement)
          outElements += countDeep(node)
          return
        }
        inElements += 1
        // Descend through shadow boundaries: the diff grid lives in the
        // `diffs-container` shadow root, and shadow content pays the same
        // whole-document pass as light DOM.
        for (const root of rootsOf(node)) {
          for (const child of root.children) walk(child)
        }
      }
      for (const child of scroller.children) walk(child)
      const priceLocking = (mode: string) => {
        const before: number[] = []
        const after: number[] = []
        for (let round = 0; round < rounds; round++) {
          for (const root of roots) root.style.removeProperty("content-visibility")
          before.push(time(5).min)
          for (const root of roots) root.style.setProperty("content-visibility", mode)
          after.push(time(5).min)
        }
        for (const root of roots) root.style.removeProperty("content-visibility")
        const best = (values: number[]) => values.sort((a, b) => a - b)[0]!
        return { before: best(before), after: best(after) }
      }
      const sample = roots
        .slice(0, 12)
        .map((root) => `${labelOf(root)}(${countDeep(root)})`)
      return {
        roots: roots.length,
        outElements,
        inElements,
        sample,
        hiddenPrice: priceLocking("hidden"),
        autoPrice: priceLocking("auto"),
      }
    }

    type CensusNodeShape = {
      path: string
      depth: number
      label: string
      elements: number
      ownContentVisibility: string
      locked: boolean
      lockedBy: string
      display: string
      visibility: string
      inert: boolean
      ariaHidden: string
      offscreen: boolean
      rect: string
    }

    ;(window as unknown as { __census: unknown }).__census = { time, count, census, charge, occupancy, subfold }
  })


type Occupancy = {
  rows: number
  onscreenRows: number
  offscreenRows: number
  onElements: number
  offElements: number
  scrollHeight: number
  portHeight: number
  hiddenPrice: { before: number; after: number }
  autoPrice: { before: number; after: number }
}

type Charge = { withSubtree: number; locked: number; delta: number; elements: number }

const THRESHOLD = Number(process.env.CLAXEDO_CENSUS_THRESHOLD ?? 40)

const lists: Array<{ name: string; scroll: string; row: string }> = [
  { name: "review accordion rows", scroll: "[data-slot='session-review-scroll']", row: "[data-component='accordion']" },
  { name: "transcript rows", scroll: "[data-slot='session-timeline-scroll']", row: "[role='region'] > div" },
  { name: "rail rows", scroll: "[data-testid='rail-sidebar']", row: "" },
]

const stage = async (page: Page, name: string) => {
  console.log(`\n\n##################### STAGE: ${name} #####################`)

  const totals = await page.evaluate(() => {
    const api = (window as unknown as { __census: { time: () => { min: number; median: number }; count: () => number } }).__census
    return { ...api.time(), elements: api.count() }
  })

  const budget = await page.evaluate(() => {
    let live = 0
    let locked = 0
    const walk = (node: Element, inheritedLock: boolean) => {
      const style = getComputedStyle(node)
      const isLocked = inheritedLock || style.getPropertyValue("content-visibility") === "hidden" || style.display === "none"
      if (isLocked) locked += 1
      else live += 1
      for (const child of node.children) walk(child, isLocked)
      const shadow = (node as HTMLElement).shadowRoot
      if (shadow) for (const child of shadow.children) walk(child, isLocked)
    }
    walk(document.documentElement, false)
    return { live, locked }
  })

  console.log(
    `\n=== ${name} / totals === floor min=${round(totals.min)}ms median=${round(totals.median)}ms` +
      ` elements=${totals.elements} live=${budget.live} locked=${budget.locked}` +
      ` perLiveEl=${round((totals.min * 1000) / Math.max(1, budget.live))}µs`,
  )

  const nodes = (await page.evaluate((threshold) => {
    const api = (window as unknown as { __census: { census: (n: number) => unknown[] } }).__census
    return api.census(threshold)
  }, THRESHOLD)) as CensusNode[]

  console.log(`\n=== ${name} / census (subtrees >= ${THRESHOLD} elements) ===`)
  for (const node of nodes) {
    const indent = "  ".repeat(Math.min(node.depth, 12))
    const label = `${indent}${node.label}`.slice(0, 64)
    const lock = node.locked
      ? (node.ownContentVisibility === "hidden" ? "LOCKED" : "locked^")
      : node.ownContentVisibility === "auto"
      ? "cv:auto"
      : "-"
    console.log(
      `  ${label.padEnd(64)} ${String(node.elements).padStart(6)}  ${lock.padEnd(8)} ${node.display.padEnd(9)}` +
        ` ${node.inert ? "inert" : "-"}/${node.ariaHidden || "-"}  ${node.offscreen ? "OFFSCREEN " : ""}${node.rect}`,
    )
  }

  console.log(`\n=== ${name} / charge (paired floor delta per big UNLOCKED owner) ===`)
  const candidates = nodes
    .filter((node) => !node.locked && node.elements >= Math.max(THRESHOLD, 60))
    .sort((a, b) => b.elements - a.elements)
    .slice(0, 12)
  for (const candidate of candidates) {
    const charged = (await page.evaluate(
      ({ path, rounds }) => {
        const api = (window as unknown as { __census: { charge: (p: string, r: number) => unknown } }).__census
        return api.charge(path, rounds)
      },
      { path: candidate.path, rounds: 3 },
    )) as Charge | undefined
    if (!charged) continue
    console.log(
      `  ${candidate.label.slice(0, 58).padEnd(58)} els=${String(charged.elements).padStart(5)}` +
        ` with=${String(round(charged.withSubtree)).padStart(6)}ms locked=${String(round(charged.locked)).padStart(6)}ms` +
        ` Δ=${String(round(charged.delta)).padStart(6)}ms`,
    )
  }

  console.log(`\n=== ${name} / sub-fold ceiling (elements entirely outside each scrollport) ===`)
  for (const list of lists) {
    const measured = (await page.evaluate(
      ({ scroll, rounds }) => {
        const api = (window as unknown as { __census: { subfold: (s: string, n: number) => unknown } }).__census
        return api.subfold(scroll, rounds)
      },
      { scroll: list.scroll, rounds: 3 },
    )) as
      | { roots: number; outElements: number; inElements: number; sample: string[]; hiddenPrice: { before: number; after: number }; autoPrice: { before: number; after: number } }
      | undefined
    if (!measured) {
      console.log(`  ${list.name.padEnd(22)} (no scroller)`)
      continue
    }
    console.log(
      `  ${list.name.padEnd(22)} outside-port roots=${measured.roots} els=${measured.outElements} (in-port els=${measured.inElements})`,
    )
    console.log(
      `  ${" ".repeat(22)} lock-outside cv:hidden ${round(measured.hiddenPrice.before)}->${round(measured.hiddenPrice.after)}ms` +
        ` (Δ=${round(measured.hiddenPrice.before - measured.hiddenPrice.after)})` +
        `   cv:auto ${round(measured.autoPrice.before)}->${round(measured.autoPrice.after)}ms` +
        ` (Δ=${round(measured.autoPrice.before - measured.autoPrice.after)})`,
    )
    if (measured.sample.length > 0) console.log(`  ${" ".repeat(22)} roots: ${measured.sample.join(" ")}`)
  }

  console.log(`\n=== ${name} / windowed-list occupancy ===`)
  for (const list of lists) {
    const measured = (await page.evaluate(
      ({ scroll, row, rounds }) => {
        const api = (window as unknown as { __census: { occupancy: (s: string, r: string, n: number) => unknown } }).__census
        return api.occupancy(scroll, row, rounds)
      },
      { scroll: list.scroll, row: list.row, rounds: 3 },
    )) as Occupancy | undefined
    if (!measured) {
      console.log(`  ${list.name.padEnd(22)} (no rows)`)
      continue
    }
    console.log(
      `  ${list.name.padEnd(22)} rows=${measured.rows} (on ${measured.onscreenRows} / off ${measured.offscreenRows})` +
        `  els on=${measured.onElements} off=${measured.offElements}` +
        `  scrollH=${measured.scrollHeight}px port=${measured.portHeight}px`,
    )
    console.log(
      `  ${" ".repeat(22)} lock-offscreen cv:hidden ${round(measured.hiddenPrice.before)}->${round(measured.hiddenPrice.after)}ms` +
        ` (Δ=${round(measured.hiddenPrice.before - measured.hiddenPrice.after)})` +
        `   cv:auto ${round(measured.autoPrice.before)}->${round(measured.autoPrice.after)}ms` +
        ` (Δ=${round(measured.autoPrice.before - measured.autoPrice.after)})`,
    )
  }
}

const app = await startApp()
const fixture = fixtureFor(SCENARIO, seedForScenario(SCENARIO))
const browser = await chromium.launch({ headless: true, args: frameSamplingLaunchArgs, timeout: 30_000 })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 300)))

await installMockApi(page, app, fixture, monitorPage(page), environmentProfile("unthrottled"))
await installSeedState(page, app, fixture)
const session = fixture.sessions[0]!
await launchTo(page, app, sessionPath(session, session.id))
await waitForTranscript(page, fixture, session.id, session.title)
await openReviewSurface(page, fixture, { settle: "frame" })
await settleBeforeNextInteraction(page)
await installMeter(page)

await stage(page, "base (review open, all rows collapsed)")

// Expanding review rows mounts diff bodies — the state a user actually reads in,
// and the one where a below-fold pool can exist.
const expanded = await page.evaluate(() => {
  const triggers = Array.from(document.querySelectorAll<HTMLElement>("[data-component='accordion'] button"))
  const clicked = triggers.slice(0, 3)
  for (const trigger of clicked) trigger.click()
  return clicked.length
})
console.log(`\n[interaction] expanded ${expanded} review rows`)
await page.waitForTimeout(1_500)
await settleBeforeNextInteraction(page)
await installMeter(page)
await stage(page, "after 3 review expands")

// Session switches are the interaction that leaves retained transcripts behind.
// Visiting several distinct sessions accumulates the retention depth a real user
// reaches (the workbench holds up to MAX_OPEN_SURFACES of them), which is the
// only state where retention's real cost is visible.
const visited: string[] = []
for (const target of fixture.sessions.slice(1, 6)) {
  // Click the rail row by its session title: the rail reorders by recency on
  // every switch, so row index and row id both drift between switches.
  const clicked = await page.evaluate((title) => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='rail-sidebar-session-row']"))
    const row = rows.find((candidate) => (candidate.textContent ?? "").includes(title))
    if (!row) return false
    const control = row.querySelector<HTMLElement>("a,button") ?? row
    control.click()
    return true
  }, target.title)
  if (!clicked) continue
  visited.push(target.title)
  await page.waitForTimeout(2_000)
}
console.log(`\n[interaction] visited ${visited.length} further sessions: ${visited.join(", ")}`)
await settleBeforeNextInteraction(page)
await installMeter(page)

// Name every mounted-but-not-displayed workbench content slot and say whether a
// whole-document style pass actually skips it. This is the claim in
// surface-budget.ts ("hidden mounted surfaces are cheap to hold") under test.
const slots = await page.evaluate(() => {
  const root = document.querySelector<HTMLElement>("[data-testid='workbench-root']")
  if (!root) return []
  return Array.from(root.children).map((child) => {
    const style = getComputedStyle(child)
    let elements = 0
    const walk = (node: Element) => {
      elements += 1
      for (const kid of node.children) walk(kid)
      const shadow = (node as HTMLElement).shadowRoot
      if (shadow) for (const kid of shadow.children) walk(kid)
    }
    walk(child)
    const rect = child.getBoundingClientRect()
    return {
      elements,
      contentVisibility: style.getPropertyValue("content-visibility"),
      visibility: style.visibility,
      opacity: style.opacity,
      display: style.display,
      contain: style.contain,
      inert: (child as HTMLElement).inert === true,
      ariaHidden: child.getAttribute("aria-hidden") ?? "",
      rect: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
    }
  })
})
console.log(`\n=== workbench content slots (retention) ===`)
for (const slot of slots) {
  console.log(
    `  els=${String(slot.elements).padStart(5)} content-visibility=${slot.contentVisibility.padEnd(8)}` +
      ` visibility=${slot.visibility.padEnd(8)} opacity=${slot.opacity.padEnd(4)} display=${slot.display.padEnd(6)}` +
      ` contain=${slot.contain.padEnd(8)} ${slot.inert ? "inert" : "-"}/${slot.ariaHidden || "-"} ${slot.rect}` +
      `   ${slot.contentVisibility === "hidden" ? "SKIPPED by style pass" : "PAYS the style pass"}`,
  )
}

await stage(page, `after ${visited.length} more session switches (retention live)`)

await browser.close()
await stopApp(app)
