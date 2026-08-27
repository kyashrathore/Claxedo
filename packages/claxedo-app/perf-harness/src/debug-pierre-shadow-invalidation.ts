// TEMP probe (read-only diagnosis): WHICH act inside @pierre/diffs marks the
// whole document for style recalculation.
//
// `debug-file-open-probe.ts` reports the symptom: every file-tab interaction
// performs TWO whole-document `UpdateLayoutTree` passes (~30ms each), and every
// page-observable trigger it watches is instrumented to zero. Blink emits the
// `ScheduleStyleRecalculation` with no JS stack, i.e. the
// `MarkAllElementsForStyleRecalc` path.
//
// This probe isolates the acts. It boots the same settled page and then, for
// each candidate act, measures the COLLATERAL whole-document recalculation the
// act causes:
//
//   settle -> flush style clean -> ACT() -> time one getComputedStyle flush
//
// A scoped act leaves the flush at ~0ms. An act that marks all elements leaves
// the flush at the document's style floor (~20-30ms). The acts are the ones
// @pierre/diffs performs per file container: creating the `diffs-container`
// custom element (constructor: `attachShadow` + `adoptedStyleSheets=[shared]`),
// appending the per-container theme `<style>` node (`upsertHostThemeStyle`),
// rewriting that node's text, appending the sprite SVG, re-assigning the same
// adopted sheet, writing the `--diffs-column-*` custom properties
// (`ResizeManager.applyColumnUpdates`), and flipping `content-visibility`.
//
// It mutates the live page's DOM, so it is a measurement tool only: it never
// runs alongside a reported benchmark, and the page is thrown away afterwards.
//
// Run (no rebuild needed):
//   cd packages/claxedo-app/perf-harness
//   CLAXEDO_PERF_SKIP_BUILD=1 CLAXEDO_PERF_MOCK_PORT=<baked> bun src/debug-pierre-shadow-invalidation.ts
import { chromium } from "@playwright/test"

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

const results = await page.evaluate(async () => {
  const LAYER_ORDER = `@layer base, theme, rendered, unsafe;`
  const THEME_CSS = `${LAYER_ORDER}
@layer rendered {
  :host {
  --diffs-scrollbar-gutter-measured: 15px;
  --diffs-fg: #111; --diffs-bg: #fff;
  }
}`
  const THEME_CSS_NO_LAYER = `:host { --diffs-fg: #111; --diffs-bg: #fff; }`

  const raf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  const settle = async () => {
    await raf()
    await raf()
    void getComputedStyle(document.body).color
  }
  /** Cost of one deliberate whole-document invalidation, for scale. */
  const floor = () => {
    const values: number[] = []
    for (let index = 0; index < 7; index++) {
      document.documentElement.style.setProperty("--claxedo-floor-probe", String(index))
      const started = performance.now()
      void getComputedStyle(document.body).color
      values.push(performance.now() - started)
    }
    document.documentElement.style.removeProperty("--claxedo-floor-probe")
    void getComputedStyle(document.body).color
    values.sort((a, b) => a - b)
    return values[Math.floor(values.length / 2)]!
  }

  const host =
    document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']") ?? document.body
  const stage = document.createElement("div")
  stage.style.cssText = "position:absolute;left:-99999px;top:0;width:400px;height:200px;"
  host.appendChild(stage)
  await settle()

  const documentFloor = floor()

  /**
   * Run `act` from a style-clean page and return the milliseconds the next
   * style flush costs. Repeated `samples` times; the median is reported so a
   * single scheduling hiccup cannot name a cause.
   */
  const collateral = async (samples: number, act: () => void) => {
    const values: number[] = []
    for (let index = 0; index < samples; index++) {
      await settle()
      act()
      const started = performance.now()
      void getComputedStyle(document.body).color
      values.push(performance.now() - started)
    }
    values.sort((a, b) => a - b)
    return { median: values[Math.floor(values.length / 2)]!, min: values[0]!, max: values.at(-1)! }
  }

  const out: { name: string; median: number; min: number; max: number; note: string }[] = []
  const record = async (name: string, note: string, samples: number, act: () => void) =>
    out.push({ name, note, ...(await collateral(samples, act)) })

  // --- A. create the real custom element (attachShadow + adoptedStyleSheets) -
  const created: HTMLElement[] = []
  await record("A create <diffs-container>", "constructor attaches shadow + adopts the shared sheet", 5, () => {
    const element = document.createElement("diffs-container")
    stage.appendChild(element)
    created.push(element as HTMLElement)
  })

  // --- B. a bare shadow host with no stylesheet at all --------------------
  await record("B attachShadow, no sheets", "isolates the tree-scope creation itself", 5, () => {
    const element = document.createElement("div")
    stage.appendChild(element)
    element.attachShadow({ mode: "open" }).appendChild(document.createElement("span"))
  })

  // --- C. adopt a SHARED constructed sheet onto a NEW shadow root ---------
  const sharedSheet = new CSSStyleSheet()
  sharedSheet.replaceSync(THEME_CSS)
  await record("C new shadow + adopt SHARED sheet", "one sheet object reused across roots", 5, () => {
    const element = document.createElement("div")
    stage.appendChild(element)
    element.attachShadow({ mode: "open" }).adoptedStyleSheets = [sharedSheet]
  })

  // --- D. adopt a FRESH constructed sheet onto a NEW shadow root ----------
  await record("D new shadow + adopt FRESH sheet", "a new CSSStyleSheet object per root", 5, () => {
    const element = document.createElement("div")
    stage.appendChild(element)
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(THEME_CSS)
    element.attachShadow({ mode: "open" }).adoptedStyleSheets = [sheet]
  })

  // --- E. append a <style> node into an EXISTING shadow root --------------
  const styleHosts: ShadowRoot[] = []
  for (let index = 0; index < 8; index++) {
    const element = document.createElement("div")
    stage.appendChild(element)
    styleHosts.push(element.attachShadow({ mode: "open" }))
  }
  await settle()
  let styleIndex = 0
  await record("E append <style> (with @layer)", "upsertHostThemeStyle's append", 5, () => {
    const node = document.createElement("style")
    node.setAttribute("data-theme-css", "")
    node.textContent = THEME_CSS
    styleHosts[styleIndex++ % styleHosts.length]!.appendChild(node)
  })

  // --- F. append a <style> node WITHOUT any @layer statement --------------
  const plainHosts: ShadowRoot[] = []
  for (let index = 0; index < 8; index++) {
    const element = document.createElement("div")
    stage.appendChild(element)
    plainHosts.push(element.attachShadow({ mode: "open" }))
  }
  await settle()
  let plainIndex = 0
  await record("F append <style> (no @layer)", "same append, layer statement removed", 5, () => {
    const node = document.createElement("style")
    node.textContent = THEME_CSS_NO_LAYER
    plainHosts[plainIndex++ % plainHosts.length]!.appendChild(node)
  })

  // --- G. rewrite the text of an ALREADY-APPENDED <style> -----------------
  const resident = document.createElement("style")
  resident.textContent = THEME_CSS
  styleHosts[0]!.appendChild(resident)
  await settle()
  let tick = 0
  await record("G rewrite resident <style>.textContent", "upsertHostThemeStyle's update path", 5, () => {
    resident.textContent = `${THEME_CSS}\n/* ${tick++} */`
  })

  // --- H. re-assign the SAME adopted sheet on an existing root ------------
  const readopt = document.createElement("div")
  stage.appendChild(readopt)
  const readoptRoot = readopt.attachShadow({ mode: "open" })
  readoptRoot.adoptedStyleSheets = [sharedSheet]
  await settle()
  await record("H re-assign same adoptedStyleSheets", "identical sheet list written again", 5, () => {
    readoptRoot.adoptedStyleSheets = [sharedSheet]
  })

  // --- I. append the sprite SVG into a shadow root ------------------------
  const spriteHost = document.createElement("div")
  stage.appendChild(spriteHost)
  const spriteRoot = spriteHost.attachShadow({ mode: "open" })
  await settle()
  const sprites: SVGElement[] = []
  for (let index = 0; index < 6; index++) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    svg.innerHTML = `<symbol id="s${index}"><path d="M0 0h8v8H0z"/></symbol>`
    sprites.push(svg)
  }
  let spriteIndex = 0
  await record("I append sprite <svg> to shadow root", "ensureSpriteSVG's append", 5, () => {
    spriteRoot.appendChild(sprites[spriteIndex++ % sprites.length]!)
  })

  // --- J. inline custom property on a <code> inside a shadow root ---------
  const codeHost = document.createElement("div")
  stage.appendChild(codeHost)
  const codeRoot = codeHost.attachShadow({ mode: "open" })
  const pre = document.createElement("pre")
  const code = document.createElement("code")
  for (let index = 0; index < 100; index++) {
    const line = document.createElement("div")
    line.textContent = `line ${index}`
    code.appendChild(line)
  }
  pre.appendChild(code)
  codeRoot.appendChild(pre)
  await settle()
  let width = 400
  await record("J applyColumnUpdates custom properties", "--diffs-column-width on <code>", 5, () => {
    code.style.setProperty("--diffs-column-width", `${width++}px`)
    code.style.setProperty("--diffs-column-number-width", `${width}px`)
  })

  // --- K. content-visibility flip on a shadow host ------------------------
  const lockHost = created[0] ?? document.createElement("div")
  if (!lockHost.isConnected) stage.appendChild(lockHost)
  await settle()
  let locked = false
  await record("K content-visibility flip on host", "DisplayLock acquire/release", 5, () => {
    locked = !locked
    lockHost.style.contentVisibility = locked ? "hidden" : "visible"
  })

  // --- L. remove a <style> from a shadow root -----------------------------
  const removable: HTMLStyleElement[] = []
  for (let index = 0; index < 6; index++) {
    const node = document.createElement("style")
    node.textContent = THEME_CSS
    styleHosts[index % styleHosts.length]!.appendChild(node)
    removable.push(node)
  }
  await settle()
  let removeIndex = 0
  await record("L remove <style> from shadow root", "cleanChildNodes' themeCSSStyle.remove()", 5, () => {
    removable[removeIndex++ % removable.length]!.remove()
  })

  // --- M..R. `:has()` anchors in the DOCUMENT's own stylesheets -----------
  // The app ships `body:has([data-slot=dialog-content].command-palette-dialog)`
  // and friends. Blink re-checks a `:has()` anchor whenever a light-DOM change
  // could alter the argument's match; when the anchor is `body`, invalidating
  // it re-matches every element below it. These acts separate "any insertion"
  // from "an insertion Blink thinks could flip a `:has()` on a high anchor".
  const hasStage = document.createElement("div")
  hasStage.style.cssText = "position:absolute;left:-99999px;top:0;"
  host.appendChild(hasStage)
  await settle()

  await record("M insert plain <div> (control)", "no attribute a :has() argument names", 5, () => {
    hasStage.appendChild(document.createElement("div"))
  })

  await record("N insert <div data-slot>", "carries an attribute a body:has() argument names", 5, () => {
    const element = document.createElement("div")
    element.setAttribute("data-slot", "pierre-probe")
    hasStage.appendChild(element)
  })

  await record("O insert <div data-component>", "attribute other :has() arguments name", 5, () => {
    const element = document.createElement("div")
    element.setAttribute("data-component", "pierre-probe")
    hasStage.appendChild(element)
  })

  const slotted = document.createElement("div")
  slotted.setAttribute("data-slot", "pierre-probe-resident")
  hasStage.appendChild(slotted)
  await settle()
  let slotTick = 0
  await record("P rewrite data-slot on a resident node", "attribute change, no insertion", 5, () => {
    slotted.setAttribute("data-slot", `pierre-probe-${slotTick++}`)
  })

  const selectable = document.createElement("div")
  selectable.setAttribute("data-slot", "tabs-trigger-wrapper")
  const selectableChild = document.createElement("div")
  selectable.appendChild(selectableChild)
  hasStage.appendChild(selectable)
  await settle()
  let selected = false
  await record("Q toggle data-selected under a :has() wrapper", "the tab-switch attribute write", 5, () => {
    selected = !selected
    if (selected) selectableChild.setAttribute("data-selected", "true")
    else selectableChild.removeAttribute("data-selected")
  })

  // A whole `diffs-container`-shaped subtree, the shape a file view mounts.
  await record("R insert a file-view-shaped subtree", "container + pre + code + 100 slotted rows", 3, () => {
    const container = document.createElement("diffs-container")
    const root = container.shadowRoot ?? container.attachShadow({ mode: "open" })
    const preNode = document.createElement("pre")
    preNode.setAttribute("data-type", "file")
    const codeNode = document.createElement("code")
    codeNode.setAttribute("data-code", "")
    for (let index = 0; index < 100; index++) {
      const row = document.createElement("div")
      row.setAttribute("data-line", String(index))
      row.setAttribute("data-slot", "line")
      const span = document.createElement("span")
      span.textContent = `const value${index} = ${index}`
      row.appendChild(span)
      codeNode.appendChild(row)
    }
    preNode.appendChild(codeNode)
    root.appendChild(preNode)
    hasStage.appendChild(container)
  })

  // --- S..Z. DOCUMENT-scope acts the app itself can perform ---------------
  // These are the remaining ways a page can mark every element for recalc.
  // `W` is the deliberate control: it is the floor by construction.
  const g = globalThis as unknown as {
    CSS?: { highlights?: { set: (n: string, h: unknown) => void; delete: (n: string) => void } }
    Highlight?: new (...ranges: Range[]) => unknown
  }
  const documentSheet = new CSSStyleSheet()
  documentSheet.replaceSync(":root { --pierre-probe-doc: 1; }")
  await record("S document.adoptedStyleSheets rewrite", "same list re-assigned on the document", 5, () => {
    document.adoptedStyleSheets = [...document.adoptedStyleSheets]
  })
  const headStyles: HTMLStyleElement[] = []
  await record("T append <style> to document.head", "a document-scope active sheet appears", 4, () => {
    const node = document.createElement("style")
    node.textContent = `.pierre-probe-${headStyles.length} { color: inherit; }`
    document.head.appendChild(node)
    headStyles.push(node)
  })
  for (const node of headStyles) node.remove()
  await settle()

  if (g.CSS?.highlights && typeof g.Highlight === "function") {
    const target = document.body.firstElementChild ?? document.body
    let highlightTick = 0
    await record("U CSS.highlights set/delete", "the file-find highlight registry mutation", 5, () => {
      if (highlightTick++ % 2 === 0) {
        const range = document.createRange()
        range.selectNodeContents(target)
        g.CSS!.highlights!.set("pierre-probe-find", new g.Highlight!(range))
      } else g.CSS!.highlights!.delete("pierre-probe-find")
    })
    g.CSS.highlights.delete("pierre-probe-find")
  }

  let rootTick = 0
  await record("W custom property on <html> (control)", "the deliberate whole-document invalidation", 5, () => {
    document.documentElement.style.setProperty("--pierre-probe-root", String(rootTick++))
  })
  document.documentElement.style.removeProperty("--pierre-probe-root")
  await settle()

  let bodyTick = 0
  await record("X custom property on <body>", "same write one level down", 5, () => {
    document.body.style.setProperty("--pierre-probe-body", String(bodyTick++))
  })
  document.body.style.removeProperty("--pierre-probe-body")
  await settle()

  let themeTick = 0
  await record("Y data attribute on <html>", "theme/attribute writes on the root element", 5, () => {
    document.documentElement.setAttribute("data-pierre-probe", String(themeTick++))
  })
  document.documentElement.removeAttribute("data-pierre-probe")
  await settle()

  hasStage.remove()
  stage.remove()
  return { documentFloor, out }
})

console.log(`\n=== whole-document style floor: ${round(results.documentFloor)}ms ===`)
console.log("(an act that marks all elements leaves a flush near the floor; a scoped act leaves ~0)\n")
for (const row of results.out) {
  const verdict = row.median > results.documentFloor * 0.4 ? "MARKS ALL" : row.median > 2 ? "partial " : "scoped   "
  console.log(
    `  ${verdict}  ${row.name.padEnd(42)} median=${String(round(row.median)).padStart(7)}ms` +
      ` min=${String(round(row.min)).padStart(7)}ms max=${String(round(row.max)).padStart(7)}ms   ${row.note}`,
  )
}

await page.close()
await browser.close()
await stopApp(app)
