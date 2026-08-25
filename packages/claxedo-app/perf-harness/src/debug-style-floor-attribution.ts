// TEMP probe (read-only diagnosis): what makes ONE whole-document style
// recalculation cost what it costs.
//
// `debug-file-open-probe.ts` prints the floor as a single number ("a deliberate
// root invalidation costs N ms over M elements"). That number says the floor is
// the plateau but not what pays for it. This probe boots the same settled page
// and then attributes that one number three ways, all on the live document, all
// without a rebuild:
//
//   sheets   disable one document stylesheet at a time and re-time the floor —
//            names the sheet whose rules the matcher is spending time in
//   synth    append N throwaway elements of a known shape and re-time — the
//            slope in ms per appended element is the marginal per-element cost
//            for THAT shape (bare <div> vs a typical app class list vs an
//            element inside a `contain: style` box)
//   props    drop the :root custom-property payload and re-time — the direct
//            test of "490 inherited custom properties make every element's
//            resolution expensive"
//
// It mutates the live page's styles and DOM, so it is a measurement tool only:
// it never runs alongside a reported benchmark, and the page is thrown away
// afterwards.
//
// Run:
//   cd packages/claxedo-app/perf-harness
//   CLAXEDO_PERF_SKIP_BUILD=1 CLAXEDO_PERF_MOCK_PORT=<baked> bun src/debug-style-floor-attribution.ts
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

const SCENARIO = "workspace-interactions" as const
const round = (value: number) => Math.round(value * 100) / 100

/** Install the in-page floor meter once; every measurement below reuses it. */
const installMeter = async (page: Page) =>
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    w.__floor = {
      // One whole-document style invalidation, timed WITHOUT layout: writing a
      // custom property on <html> dirties every element, and reading a computed
      // colour flushes style alone.
      time: (samples = 7) => {
        const values: number[] = []
        for (let index = 0; index < samples; index++) {
          document.documentElement.style.setProperty("--claxedo-floor-probe", String(index))
          const started = performance.now()
          void getComputedStyle(document.body).color
          values.push(performance.now() - started)
        }
        document.documentElement.style.removeProperty("--claxedo-floor-probe")
        void getComputedStyle(document.body).color
        values.sort((a, b) => a - b)
        return { min: values[0]!, median: values[Math.floor(values.length / 2)]! }
      },
      count: () => {
        let total = document.querySelectorAll("*").length
        for (const host of document.querySelectorAll("*")) {
          const shadow = (host as HTMLElement).shadowRoot
          if (shadow) total += shadow.querySelectorAll("*").length
        }
        return total
      },
    }
  })

const floor = async (page: Page) =>
  await page.evaluate(() => {
    const w = window as unknown as { __floor: { time: (n?: number) => { min: number; median: number }; count: () => number } }
    const timing = w.__floor.time()
    return { ...timing, elements: w.__floor.count() }
  })

const report = (label: string, value: { min: number; median: number; elements: number }, baseline?: number) =>
  console.log(
    `  ${label.padEnd(42)} min=${String(round(value.min)).padStart(7)}ms` +
      ` median=${String(round(value.median)).padStart(7)}ms` +
      ` els=${String(value.elements).padStart(5)}` +
      ` perEl=${String(round((value.min * 1000) / Math.max(1, value.elements))).padStart(6)}µs` +
      (baseline === undefined ? "" : `  Δ=${round(value.min - baseline)}ms`),
  )

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

console.log("\n=== 0. baseline floor ===")
const baseline = await floor(page)
report("settled document", baseline)

console.log("\n=== 1. sheet attribution (one sheet disabled at a time) ===")
const sheets = await page.evaluate(() =>
  Array.from(document.styleSheets).map((sheet, index) => {
    let rules = 0
    const countRules = (list: CSSRuleList) => {
      for (const rule of Array.from(list)) {
        rules += 1
        const nested = (rule as unknown as { cssRules?: CSSRuleList }).cssRules
        if (nested) countRules(nested)
      }
    }
    try {
      countRules(sheet.cssRules)
    } catch {
      rules = -1
    }
    return {
      index,
      rules,
      href: sheet.href?.slice(sheet.href.lastIndexOf("/") + 1) ?? `<inline #${(sheet.ownerNode as Element | null)?.id || index}>`,
    }
  })
)
for (const sheet of sheets) {
  await page.evaluate((index) => {
    const sheet = document.styleSheets[index]
    if (sheet) sheet.disabled = true
  }, sheet.index)
  const measured = await floor(page)
  await page.evaluate((index) => {
    const sheet = document.styleSheets[index]
    if (sheet) sheet.disabled = false
  }, sheet.index)
  report(`off: ${sheet.href} (${sheet.rules} rules)`, measured, baseline.min)
}

console.log("\n=== 2. marginal per-element cost by element shape ===")
const shapes: Array<{ name: string; build: string }> = [
  { name: "bare <div> (identical: style-sharing applies)", build: "bare" },
  { name: "<div> unique class (no style sharing)", build: "unique" },
  { name: "<div> unique class + typical app class list", build: "classy" },
  { name: "<div> unique class + data-slot + data-component", build: "slotted" },
  { name: "<div> unique class, mounted DEEP in the panel", build: "deep" },
  { name: "<div> unique class + app classes, DEEP in the panel", build: "deep-classy" },
  { name: "<div> unique class inside contain:style box", build: "contained" },
  { name: "<div> unique class inside content-visibility:hidden", build: "hidden" },
]
for (const shape of shapes) {
  const measured = await page.evaluate((build) => {
    const w = window as unknown as { __floor: { time: (n?: number) => { min: number; median: number }; count: () => number } }
    const host = document.createElement("div")
    host.id = "claxedo-floor-synth"
    if (build === "contained") host.style.contain = "style"
    if (build === "hidden") host.style.contentVisibility = "hidden"
    // Off-screen but still styled: `display:none` would skip recalc entirely
    // and measure nothing.
    host.style.position = "absolute"
    host.style.top = "-100000px"
    for (let index = 0; index < 2000; index++) {
      const node = document.createElement("div")
      // A unique class per node defeats Blink's sibling style sharing, so the
      // marginal number is a real per-element resolution cost rather than the
      // cost of resolving one style and reusing it 1999 times.
      if (build !== "bare") node.className = `claxedo-floor-u${index}`
      if (build === "classy" || build === "deep-classy") {
        node.className +=
          " group relative my-1 ml-0.5 flex h-7 max-w-[180px] shrink-0 items-center rounded-md border border-transparent text-13-medium transition-[background-color,color] duration-100 text-text-weak hover:bg-surface-base-hover/35 hover:text-text-base"
      }
      if (build === "slotted") {
        node.setAttribute("data-slot", "claxedo-floor")
        node.setAttribute("data-component", "claxedo-floor")
      }
      host.append(node)
    }
    // "deep" variants mount inside the real panel subtree, so the nodes carry
    // the app's actual ancestor chain: that isolates "matching against this
    // stylesheet is expensive" from "matching under THESE ancestors is".
    const deepest = build.startsWith("deep")
      ? Array.from(document.querySelectorAll<HTMLElement>("[data-testid='workspace-panel-shell'] *"))
        .reduce<{ node: HTMLElement | null; depth: number }>((best, candidate) => {
          let depth = 0
          for (let node: Element | null = candidate; node; node = node.parentElement) depth += 1
          return depth > best.depth ? { node: candidate, depth } : best
        }, { node: null, depth: 0 }).node
      : null
    ;(deepest ?? document.body).append(host)
    const timing = w.__floor.time()
    const elements = w.__floor.count()
    host.remove()
    return { ...timing, elements }
  }, shape.build)
  report(`+2000 ${shape.name}`, measured, baseline.min)
  console.log(
    `  ${" ".repeat(42)} marginal ${round(((measured.min - baseline.min) * 1000) / 2000)}µs per appended element`,
  )
}

console.log("\n=== 3. :root custom-property payload ===")
const props = await page.evaluate(() => {
  const names: string[] = []
  const walk = (list: CSSRuleList) => {
    for (const rule of Array.from(list)) {
      const nested = (rule as unknown as { cssRules?: CSSRuleList }).cssRules
      if (nested) walk(nested)
      if (!(rule instanceof CSSStyleRule)) continue
      if (!/(^|,)\s*(:root|html\[data-theme)/.test(rule.selectorText)) continue
      for (const name of Array.from(rule.style)) if (name.startsWith("--")) names.push(name)
    }
  }
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules)
    } catch {
      // unreadable
    }
  }
  return Array.from(new Set(names))
})
console.log(`  distinct :root custom properties: ${props.length}`)
const withoutProps = await page.evaluate((names) => {
  const w = window as unknown as { __floor: { time: (n?: number) => { min: number; median: number }; count: () => number } }
  // Re-declare every root token as its own computed value, but on a NON-root
  // element, so nothing inherits them from <html> any more. Purely diagnostic:
  // the page looks wrong afterwards.
  const computed = getComputedStyle(document.documentElement)
  const saved = names.map((name) => [name, computed.getPropertyValue(name)] as const)
  const killer = document.createElement("style")
  killer.id = "claxedo-floor-killer"
  killer.textContent = `:root{${names.map((name) => `${name}:initial !important`).join(";")}}`
  document.head.append(killer)
  const timing = w.__floor.time()
  const elements = w.__floor.count()
  killer.remove()
  return { ...timing, elements, restored: saved.length }
}, props)
report(`:root tokens dropped (${props.length})`, withoutProps, baseline.min)

console.log("\n=== 3b. matching vs. applying: same selectors, empty declarations ===")
// Swap the main sheet for a copy that keeps every selector but declares
// nothing. If the floor stays high the cost is selector MATCHING; if it
// collapses the cost is APPLYING the declarations (var() substitution,
// color-mix, custom properties).
const mainHref = sheets.find((sheet) => sheet.href.startsWith("main-"))?.href
if (mainHref) {
  const stripped = await page.evaluate(async (href) => {
    const sheet = Array.from(document.styleSheets).find((candidate) => candidate.href?.endsWith(href))
    if (!sheet) return undefined
    const text = await (await fetch(sheet.href!)).text()
    // Blank the contents of every declaration block that is not an at-rule
    // prelude, keeping nesting and selectors byte-for-byte.
    const emptied = text.replaceAll(/(^|[{}])([^{}@]*?)\{([^{}]*)\}/g, (_match, lead, prelude) => `${lead}${prelude}{}`)
    const style = document.createElement("style")
    style.id = "claxedo-floor-stripped"
    style.textContent = emptied
    document.head.append(style)
    sheet.disabled = true
    return { rules: style.sheet?.cssRules.length ?? 0 }
  }, mainHref)
  const measured = await floor(page)
  await page.evaluate((href) => {
    document.getElementById("claxedo-floor-stripped")?.remove()
    const sheet = Array.from(document.styleSheets).find((candidate) => candidate.href?.endsWith(href))
    if (sheet) sheet.disabled = false
  }, mainHref)
  report(`main sheet: selectors only (${stripped?.rules ?? 0} top rules)`, measured, baseline.min)
}

console.log("\n=== 3c. marginal cost of ONE MORE RULE, by selector shape ===")
// Blink buckets rules by the rightmost compound (id / class / attribute name /
// tag / universal) and only tries a bucket against elements that can hit it.
// Appending 2000 never-matching rules of one shape and re-timing the floor
// measures how well that bucketing actually works in THIS document: a shape
// whose bucket is reached by most elements costs, one that is skipped is free.
const shapeCounts = await page.evaluate(() => {
  const withAttribute = (name: string) => document.querySelectorAll(`[${name}]`).length
  return {
    total: document.querySelectorAll("*").length,
    dataSlot: withAttribute("data-slot"),
    dataComponent: withAttribute("data-component"),
    dataTestid: withAttribute("data-testid"),
    classed: document.querySelectorAll("[class]").length,
  }
})
console.log(`  elements: ${shapeCounts.total} total, ${shapeCounts.classed} with class,` +
  ` ${shapeCounts.dataSlot} with data-slot, ${shapeCounts.dataComponent} with data-component,` +
  ` ${shapeCounts.dataTestid} with data-testid`)
const ruleShapes: Array<{ name: string; template: string }> = [
  { name: "[data-slot=\"...\"]", template: '[data-slot="claxedo-floor-INDEX"]' },
  { name: "[data-component=\"...\"]", template: '[data-component="claxedo-floor-INDEX"]' },
  { name: "[data-testid=\"...\"]", template: '[data-testid="claxedo-floor-INDEX"]' },
  { name: ".class", template: ".claxedo-floor-INDEX" },
  { name: "tag div.class", template: "div.claxedo-floor-INDEX" },
  { name: "#id", template: "#claxedo-floor-INDEX" },
]
for (const shape of ruleShapes) {
  const measured = await page.evaluate((template) => {
    const w = window as unknown as { __floor: { time: (n?: number) => { min: number; median: number }; count: () => number } }
    const style = document.createElement("style")
    style.id = "claxedo-floor-rules"
    const rules: string[] = []
    for (let index = 0; index < 2000; index++) rules.push(`${template.replace("INDEX", String(index))}{color:red}`)
    style.textContent = rules.join("")
    document.head.append(style)
    const timing = w.__floor.time()
    const elements = w.__floor.count()
    style.remove()
    return { ...timing, elements }
  }, shape.template)
  report(`+2000 rules ${shape.name}`, measured, baseline.min)
  console.log(`  ${" ".repeat(42)} marginal ${round(((measured.min - baseline.min) * 1000) / 2000)}µs per added rule`)
}

console.log("\n=== 3d. marginal cost of a REGISTERED custom property (@property) ===")
// A registered custom property has an initial value that every element carries,
// so each registration adds work to EVERY element's style resolution — unlike
// an unregistered `:root` token, which is inherited by reference.
const registered = await page.evaluate(() => {
  let count = 0
  const walk = (list: CSSRuleList) => {
    for (const rule of Array.from(list)) {
      if (rule.constructor.name === "CSSPropertyRule") count += 1
      const nested = (rule as unknown as { cssRules?: CSSRuleList }).cssRules
      if (nested) walk(nested)
    }
  }
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules)
    } catch {
      // unreadable
    }
  }
  return count
})
console.log(`  @property registrations already in the document: ${registered}`)
for (const inherits of [false, true]) {
  const measured = await page.evaluate((inheritsValue) => {
    const w = window as unknown as { __floor: { time: (n?: number) => { min: number; median: number }; count: () => number } }
    const style = document.createElement("style")
    style.id = "claxedo-floor-registered"
    const rules: string[] = []
    for (let index = 0; index < 200; index++) {
      rules.push(`@property --claxedo-floor-r${index}{syntax:"*";inherits:${inheritsValue};initial-value:0}`)
    }
    style.textContent = rules.join("")
    document.head.append(style)
    const timing = w.__floor.time()
    const elements = w.__floor.count()
    style.remove()
    return { ...timing, elements }
  }, inherits)
  report(`+200 @property inherits:${inherits}`, measured, baseline.min)
  console.log(`  ${" ".repeat(42)} marginal ${round(((measured.min - baseline.min) * 1000) / 200)}µs per registration`)
}

console.log("\n=== 4. per-region containment probe ===")
const regions = await page.evaluate(() => {
  const selectors = [
    "[data-testid='workspace-panel-shell']",
    "[data-component='session-prompt-dock']",
    "[data-testid='rail-sidebar-shell']",
    "[data-component='message-timeline']",
    "#review-panel",
  ]
  return selectors.map((selector) => {
    const element = document.querySelector(selector)
    if (!element) return { selector, present: false, elements: 0 }
    let total = element.querySelectorAll("*").length
    for (const host of element.querySelectorAll("*")) {
      const shadow = (host as HTMLElement).shadowRoot
      if (shadow) total += shadow.querySelectorAll("*").length
    }
    return { selector, present: true, elements: total, contain: getComputedStyle(element).contain, cv: getComputedStyle(element).contentVisibility }
  })
})
for (const region of regions) {
  console.log(
    `  ${region.selector.padEnd(46)} present=${region.present} els=${region.elements}` +
      (region.present ? ` contain=${(region as { contain?: string }).contain} content-visibility=${(region as { cv?: string }).cv}` : ""),
  )
}
console.log("\n  -- floor with one region display-locked (content-visibility: hidden) --")
for (const region of regions.filter((candidate) => candidate.present)) {
  const measured = await page.evaluate((selector) => {
    const w = window as unknown as { __floor: { time: (n?: number) => { min: number; median: number }; count: () => number } }
    const element = document.querySelector<HTMLElement>(selector)!
    const previous = element.style.contentVisibility
    element.style.contentVisibility = "hidden"
    const timing = w.__floor.time()
    const elements = w.__floor.count()
    element.style.contentVisibility = previous
    return { ...timing, elements }
  }, region.selector)
  report(`locked: ${region.selector} (${region.elements} els)`, measured, baseline.min)
}
console.log("\n  -- floor with the WHOLE body display-locked (absolute lower bound) --")
const bodyLocked = await page.evaluate(() => {
  const w = window as unknown as { __floor: { time: (n?: number) => { min: number; median: number }; count: () => number } }
  const previous = document.body.style.contentVisibility
  document.body.style.contentVisibility = "hidden"
  const timing = w.__floor.time()
  const elements = w.__floor.count()
  document.body.style.contentVisibility = previous
  return { ...timing, elements }
})
report("locked: body", bodyLocked, baseline.min)

console.log("\n=== 4b. does a DOM act by itself force a whole-document recalc? ===")
// Same meter, but instead of deliberately dirtying <html> the page performs one
// candidate act and then flushes style. An act that costs the full floor is a
// whole-document invalidation in disguise — the ones a MutationObserver on
// <head>/<html>/<body> cannot see.
const acts: Array<{ name: string; act: string }> = [
  { name: "control: nothing", act: "noop" },
  { name: "attachShadow on a new div", act: "shadow" },
  { name: "attachShadow + adoptedStyleSheets=[shared]", act: "adopt-shared" },
  { name: "attachShadow + adoptedStyleSheets=[new]", act: "adopt-new" },
  { name: "append <style> into a shadow root", act: "shadow-style" },
  { name: "append <style> into document.head", act: "head-style" },
  { name: "toggle a class on a mid-tree div", act: "class-flip" },
  { name: "write --x on a mid-tree div", act: "prop-mid" },
]
for (const entry of acts) {
  const measured = await page.evaluate((act) => {
    const w = window as unknown as { __floor: { time: (n?: number) => { min: number; median: number }; count: () => number } }
    const shared = new CSSStyleSheet()
    shared.replaceSync(":host{display:block}span{color:red}")
    const mid = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")!
    const samples: number[] = []
    for (let index = 0; index < 5; index++) {
      const host = document.createElement("div")
      document.body.append(host)
      let cleanup = () => host.remove()
      const perform = () => {
        if (act === "shadow") host.attachShadow({ mode: "open" })
        else if (act === "adopt-shared") host.attachShadow({ mode: "open" }).adoptedStyleSheets = [shared]
        else if (act === "adopt-new") {
          const sheet = new CSSStyleSheet()
          sheet.replaceSync(":host{display:block}span{color:red}")
          host.attachShadow({ mode: "open" }).adoptedStyleSheets = [sheet]
        } else if (act === "shadow-style") {
          const root = host.attachShadow({ mode: "open" })
          const style = document.createElement("style")
          style.textContent = ":host{display:block}span{color:red}"
          root.append(style)
        } else if (act === "head-style") {
          const style = document.createElement("style")
          style.id = `claxedo-floor-act-${index}`
          style.textContent = ".claxedo-floor-nothing{color:red}"
          document.head.append(style)
          cleanup = () => {
            style.remove()
            host.remove()
          }
        } else if (act === "class-flip") {
          mid.classList.toggle("claxedo-floor-flip")
          cleanup = () => {
            mid.classList.remove("claxedo-floor-flip")
            host.remove()
          }
        } else if (act === "prop-mid") {
          mid.style.setProperty("--claxedo-floor-mid", String(index))
          cleanup = () => {
            mid.style.removeProperty("--claxedo-floor-mid")
            host.remove()
          }
        }
      }
      perform()
      const started = performance.now()
      void getComputedStyle(document.body).color
      samples.push(performance.now() - started)
      cleanup()
      void getComputedStyle(document.body).color
    }
    samples.sort((a, b) => a - b)
    return { min: samples[0]!, median: samples[Math.floor(samples.length / 2)]!, elements: w.__floor.count() }
  }, entry.act)
  report(entry.name, measured)
}

console.log("\n=== 5. hot-subtree bisect ===")
// Descend from <body>, display-locking one child at a time and re-timing the
// floor. The child whose lock saves the most is where the recalc time lives;
// repeat inside it until the saving stops concentrating. This names the exact
// DOM region that pays for a whole-document invalidation.
const describe = (path: string) => path
let cursor = "BODY"
for (let depth = 0; depth < 8; depth++) {
  const children = await page.evaluate((path) => {
    const resolve = (value: string): Element | null => {
      let node: Element | null = document.body
      for (const step of value.split(">").slice(1)) {
        if (!node) return null
        node = node.children[Number(step)] ?? null
      }
      return node
    }
    const parent = resolve(path)
    if (!parent) return []
    return Array.from(parent.children).map((child, index) => {
      let total = child.querySelectorAll("*").length
      for (const host of child.querySelectorAll("*")) {
        const shadow = (host as HTMLElement).shadowRoot
        if (shadow) total += shadow.querySelectorAll("*").length
      }
      return {
        index,
        path: `${path}>${index}`,
        label: `${child.tagName.toLowerCase()}${child.id ? `#${child.id}` : ""}` +
          `${child.getAttribute("data-testid") ? `[${child.getAttribute("data-testid")}]` : ""}` +
          `${child.getAttribute("data-component") ? `{${child.getAttribute("data-component")}}` : ""}` +
          `${child.getAttribute("data-slot") ? `<${child.getAttribute("data-slot")}>` : ""}`,
        elements: total,
      }
    })
  }, cursor)
  if (children.length === 0) break
  const measurements: Array<{ path: string; label: string; elements: number; saved: number }> = []
  for (const child of children) {
    if (child.elements < 20) continue
    const measured = await page.evaluate((path) => {
      const w = window as unknown as { __floor: { time: (n?: number) => { min: number; median: number }; count: () => number } }
      const resolve = (value: string): Element | null => {
        let node: Element | null = document.body
        for (const step of value.split(">").slice(1)) {
          if (!node) return null
          node = node.children[Number(step)] ?? null
        }
        return node
      }
      const element = resolve(path) as HTMLElement | null
      if (!element) return undefined
      const previous = element.style.contentVisibility
      element.style.contentVisibility = "hidden"
      const timing = w.__floor.time()
      element.style.contentVisibility = previous
      return timing
    }, child.path)
    if (!measured) continue
    measurements.push({ path: child.path, label: child.label, elements: child.elements, saved: baseline.min - measured.min })
  }
  measurements.sort((a, b) => b.saved - a.saved)
  const best = measurements[0]
  if (!best || best.saved < 2) break
  for (const row of measurements.slice(0, 4)) {
    console.log(
      `  depth ${depth} ${describe(row.path).padEnd(18)} ${row.label.padEnd(46)}` +
        ` els=${String(row.elements).padStart(5)} saves ${round(row.saved)}ms` +
        ` (${round((row.saved * 1000) / Math.max(1, row.elements))}µs/el)`,
    )
  }
  cursor = best.path
}

console.log("\n=== 6. candidate: display-lock the SVG sprite roots ===")
// The sprites are `<svg width=0 height=0>` holders of `<symbol>` definitions:
// hundreds of elements that never paint but are style-resolved on every
// whole-document invalidation. Display-locking them removes them from every
// recalc — but `<use>` builds its instance tree from those symbols, so the
// screenshots on either side are the acceptance evidence, not the timing.
const spriteStats = await page.evaluate(() => {
  const roots = Array.from(document.querySelectorAll<SVGSVGElement>("svg[id$='-icon-sprite']"))
  let elements = 0
  for (const root of roots) elements += root.querySelectorAll("*").length
  return { roots: roots.map((root) => root.id), elements, uses: document.querySelectorAll("use").length }
})
console.log(`  sprite roots: ${spriteStats.roots.join(", ")} — ${spriteStats.elements} elements, ${spriteStats.uses} <use> instances`)
const shotDir = process.env.PROBE_SHOT_DIR ?? "/tmp/claxedo-style-floor"
await page.screenshot({ path: `${shotDir}/sprites-visible.png` })
const spriteLocked = await page.evaluate(() => {
  const w = window as unknown as { __floor: { time: (n?: number) => { min: number; median: number }; count: () => number } }
  for (const root of Array.from(document.querySelectorAll<SVGSVGElement>("svg[id$='-icon-sprite']"))) {
    root.style.contentVisibility = "hidden"
  }
  const timing = w.__floor.time(11)
  return { ...timing, elements: w.__floor.count() }
})
await page.screenshot({ path: `${shotDir}/sprites-locked.png` })
await page.evaluate(() => {
  for (const root of Array.from(document.querySelectorAll<SVGSVGElement>("svg[id$='-icon-sprite']"))) {
    root.style.removeProperty("content-visibility")
  }
})
report("sprites display-locked", spriteLocked, baseline.min)
console.log(`  screenshots: ${shotDir}/sprites-visible.png vs ${shotDir}/sprites-locked.png`)

console.log("\n=== 7. is a display:none subtree already free? ===")
const hiddenShape = await page.evaluate(() => {
  const w = window as unknown as { __floor: { time: (n?: number) => { min: number; median: number }; count: () => number } }
  const host = document.createElement("div")
  host.style.display = "none"
  for (let index = 0; index < 2000; index++) {
    const node = document.createElement("div")
    node.className = `claxedo-floor-n${index} flex items-center rounded-md border text-13-medium`
    host.append(node)
  }
  document.body.append(host)
  const timing = w.__floor.time()
  const elements = w.__floor.count()
  host.remove()
  return { ...timing, elements }
})
report("+2000 <div> inside display:none", hiddenShape, baseline.min)
console.log(`  ${" ".repeat(42)} marginal ${round(((hiddenShape.min - baseline.min) * 1000) / 2000)}µs per hidden element`)

await browser.close()
await stopApp(app)
process.exit(0)
