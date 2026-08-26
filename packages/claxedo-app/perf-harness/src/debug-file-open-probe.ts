// TEMP probe (read-only diagnosis): the fast meter for the file-viewer
// experiment loop.
//
// It reproduces the FILE-TAB cells of the `workspace-interactions` scenario
// driver (browser-runner.ts -> workspaceInteractions) — and only those — so a
// change to the file viewer can be measured in ~60s instead of a full
// `bun run run` pass. Measured, in the driver's own order:
//
//   tab_switch_to_a   activate an already-open standard file tab (320 lines)
//   tab_switch_to_b   activate the other already-open standard file tab
//   open_file         open a NEW standard file tab (320 lines) from the tree
//   close_file        close that tab again
//   open_large_file   open the 3200-line file — the headline
//
// For each it prints the per-click completion / script / style / layout /
// worst-frame numbers, plus DOM counts of the mounted file view (host element
// count AND the shadow-root line rows the code viewer actually materialized),
// which is what separates "renders every line" from "windows the lines".
//
// It also prints, once, the app's whole-document style-recalc FLOOR (what one
// deliberate root invalidation costs, and what that is per element), and per
// interaction every whole-document invalidation source it can observe — a
// document stylesheet added, removed, rewritten or mutated through the CSSOM;
// `adoptedStyleSheets` assigned on the document or any shadow root; a font
// finishing load; an <html>/<body> attribute write; an inherited custom
// property written on any high ancestor; a media query flipping; the layout
// viewport changing size. That is the difference between "this interaction
// styles its own subtree" and "this interaction restyles the document".
//
// It closes with the floor's COMPOSITION in the file-open state: each large
// region is display-locked in turn and the floor re-timed, so the saving names
// that region's share of every recalculation the interactions perform.
// `content-visibility` is the only mechanism that removes a subtree from a
// whole-document recalc — `contain: style` does not — which is why the
// composition is measured with a display lock.
//
// PROBE_DOM_PEAK=1 additionally samples light/shadow element counts on every
// readiness frame and reports the peak. That costs a whole-document
// querySelectorAll per frame, so it perturbs the numbers printed beside it:
// use it to attribute, never to report.
//
// PROBE_CHEAP_READY=1 replaces the driver's readiness predicate (which calls
// getComputedStyle on every div/span under the panel, every frame) with a
// text-only scan, to separate what the interaction costs from what MEASURING
// it costs.
//
// Run (first pass builds the app, ~2min; reruns ~60s):
//   cd packages/claxedo-app/perf-harness
//   bun src/debug-file-open-probe.ts
//   CLAXEDO_PERF_SKIP_BUILD=1 CLAXEDO_PERF_MOCK_PORT=<baked> bun src/debug-file-open-probe.ts
//
// CLAXEDO_PERF_MOCK_PORT must equal the mock port baked into ../dist at build
// time; read it with:
//   grep -ohE '127\.0\.0\.1:[0-9]{4,5}' ../dist/assets/*.js | sort | uniq -c
//
// The probe never touches application source; it only drives the built app.
import { chromium, type Locator, type Page } from "@playwright/test"
// Causal attribution (script/style/layout + the trusted-window trace) is
// opt-in inside frame-sampler, read at call time. The probe exists to print
// that attribution, so it turns the flag on for itself unless overridden.
process.env.CLAXEDO_PERF_CAUSAL ??= "1"

import { frameSamplingLaunchArgs, type FrameMetric } from "./frame-sampler"
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
import {
  ISOLATED_INTERACTION_TIMEOUT_MS,
  measureIsolatedInteraction,
  prepareTrustedInteraction,
  settleBeforeNextInteraction,
  type IsolatedInteractionObservation,
} from "./isolated-interaction"
import { seedForScenario } from "./seed"
import {
  WORKSPACE_INTERACTIONS_LARGE_FILE_PATH,
  WORKSPACE_INTERACTIONS_OPEN_FILE_PATH,
  WORKSPACE_INTERACTIONS_PRELOADED_FILE_PATHS,
} from "./workspace-interactions-contract"

const SCENARIO = "workspace-interactions" as const
const RENDERER_DEADLINE_MS = 16.67
const TARGET_MS = 50

const round = (value: number) => Math.round(value * 100) / 100
const ms = (value: number | undefined) => (value === undefined ? "n/a" : `${round(value)}ms`)
const basename = (value: string) => value.slice(value.lastIndexOf("/") + 1)

type Mode =
  | { kind: "activate-file"; filePath: string }
  | { kind: "close-tab"; tabId: string; openTabsBefore: number }

type Observation = IsolatedInteractionObservation & {
  openTabIds: string[]
  activeTabId?: string
  /** PROBE_DOM_PEAK=1 only: the largest DOM the interaction ever owned. */
  peakElements?: number
  peakShadowElements?: number
}

/**
 * In-page readiness loop for the two file-tab interaction kinds this probe
 * measures. One serialized copy of the matching branches of
 * `observeWorkspacePanelInteraction` (browser-runner.ts, module-private).
 * Keep in sync with the driver — this probe is only useful while it measures
 * the same thing.
 */
const observeFileInteraction = async (params: {
  mark: string
  timeoutMs: number
  mode: Mode
  peak: boolean
  cheapReady: boolean
}): Promise<Observation> => {
  const started = performance.getEntriesByName(params.mark, "mark").at(-1)?.startTime
  if (started === undefined) throw new Error(`Trusted ${params.mode.kind} interaction did not emit pointerdown`)
  const visible = (element: Element) => {
    if (element.closest("[aria-hidden='true']")) return false
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
  }
  const shell = () => document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
  const tabsSnapshot = () => {
    const tabs = Array.from(shell()?.querySelectorAll<HTMLElement>("[data-slot='workspace-tab']") ?? [])
    return {
      openTabIds: tabs.map((tab) => tab.dataset.workspaceTabId ?? ""),
      activeTabId: tabs.find((tab) => tab.dataset.selected === "true")?.dataset.workspaceTabId,
    }
  }
  // The driver's own predicate: a whole-panel scan that calls getComputedStyle
  // on every div/span, every frame. `cheapReady` swaps it for a text-only scan
  // so the probe can measure how much of an interaction's style recalculation
  // the MEASUREMENT is responsible for — a forced style flush inside a
  // display-locked (`content-visibility`) subtree is not free.
  const loadingVisible = () => {
    const current = shell()
    if (!current) return false
    if (params.cheapReady) {
      return Array.from(current.querySelectorAll<HTMLElement>("div, span"))
        .some((node) => node.children.length === 0 && node.textContent?.trim() === "Loading...")
    }
    return Array.from(current.querySelectorAll<HTMLElement>("div, span"))
      .some((node) => visible(node) && node.children.length === 0 && node.textContent?.trim() === "Loading...")
  }
  const mode = params.mode
  const acknowledge = (): boolean => {
    if (mode.kind === "activate-file") {
      return !!shell()?.querySelector(`[data-testid='tab-file-root'][data-tab-file-path="${CSS.escape(mode.filePath)}"]`)
    }
    return tabsSnapshot().openTabIds.length < mode.openTabsBefore
  }
  const ready = (): boolean => {
    if (mode.kind === "activate-file") {
      const root = shell()?.querySelector<HTMLElement>(
        `[data-testid='tab-file-root'][data-tab-file-path="${CSS.escape(mode.filePath)}"][data-tab-file-state='ready']`,
      )
      if (!root) return false
      return (params.cheapReady ? root.getBoundingClientRect().height > 0 : visible(root)) && !loadingVisible()
    }
    const tabs = tabsSnapshot()
    if (tabs.openTabIds.includes(mode.tabId)) return false
    if (tabs.openTabIds.length !== mode.openTabsBefore - 1) return false
    return tabs.activeTabId !== undefined && !loadingVisible()
  }
  let acknowledgedMs: number | undefined
  let stableFrames = 0
  let lastSignature = ""
  let peakElements = 0
  let peakShadowElements = 0
  const samplePeak = () => {
    const elements = document.querySelectorAll("*")
    let shadow = 0
    for (const host of elements) {
      const root = (host as HTMLElement).shadowRoot
      if (root) shadow += root.querySelectorAll("*").length
    }
    peakElements = Math.max(peakElements, elements.length)
    peakShadowElements = Math.max(peakShadowElements, shadow)
  }
  const completionMs = await new Promise<number>((resolve) => {
    const tick = () => {
      const elapsed = performance.now() - started
      if (params.peak) samplePeak()
      if (acknowledgedMs === undefined && acknowledge()) acknowledgedMs = elapsed
      const isReady = ready()
      const signature = JSON.stringify(tabsSnapshot())
      stableFrames = isReady && signature === lastSignature ? stableFrames + 1 : isReady ? 1 : 0
      lastSignature = signature
      if (stableFrames >= 2 || elapsed >= params.timeoutMs) return resolve(elapsed)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  performance.clearMarks(params.mark)
  const tabs = tabsSnapshot()
  return {
    completionMs,
    acknowledgedMs,
    timedOut: completionMs >= params.timeoutMs,
    ...tabs,
    ...(params.peak ? { peakElements, peakShadowElements } : {}),
  }
}

/**
 * DOM weight of the mounted file views. The code viewer draws into a shadow
 * root, so a plain element count under the panel cannot see the line rows —
 * both numbers are needed to tell "windowed" from "every line materialized".
 */
const readFileViewDom = async (page: Page) =>
  await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    const roots = Array.from(shell?.querySelectorAll<HTMLElement>("[data-testid='tab-file-root']") ?? [])
    const shadowStats = (root: HTMLElement) => {
      let elements = 0
      let lines = 0
      for (const host of root.querySelectorAll("*")) {
        const shadow = (host as HTMLElement).shadowRoot
        if (!shadow) continue
        elements += shadow.querySelectorAll("*").length
        lines += shadow.querySelectorAll("[data-line]").length
      }
      return { elements, lines }
    }
    let documentShadowElements = 0
    for (const host of document.querySelectorAll("*")) {
      const shadow = (host as HTMLElement).shadowRoot
      if (shadow) documentShadowElements += shadow.querySelectorAll("*").length
    }
    // The floor: how long a deliberate whole-document style invalidation
    // costs right now. An interaction whose UpdateLayoutTree approaches this
    // is recalculating the document, not its own subtree.
    document.documentElement.style.setProperty("--claxedo-probe-invalidate", String(Math.random()))
    const started = performance.now()
    void document.body.offsetHeight
    const fullRecalcMs = performance.now() - started
    document.documentElement.style.removeProperty("--claxedo-probe-invalidate")
    void document.body.offsetHeight
    return {
      mountedFileViews: roots.length,
      views: roots.map((root) => ({
        path: root.dataset.tabFilePath ?? "",
        contentLines: Number(root.dataset.tabFileContentLines ?? "0"),
        lightElements: root.querySelectorAll("*").length,
        ...shadowStats(root),
      })),
      panelElements: shell?.querySelectorAll("*").length ?? 0,
      documentElements: document.querySelectorAll("*").length,
      documentShadowElements,
      fullRecalcMs: Math.round(fullRecalcMs * 100) / 100,
    }
  })

/**
 * The style-recalc FLOOR, measured three ways on the settled page: a
 * whole-document invalidation, a panel-only invalidation, and a file-view-only
 * invalidation, each with the element count it swept. Per-element cost tells
 * "the viewer builds too many elements" apart from "every element is expensive
 * to style".
 */
const readStyleProfile = async (page: Page) =>
  await page.evaluate(() => {
    const countUnder = (root: Element) => {
      let total = root.querySelectorAll("*").length
      for (const host of root.querySelectorAll("*")) {
        const shadow = (host as HTMLElement).shadowRoot
        if (shadow) total += shadow.querySelectorAll("*").length
      }
      return total
    }
    // `getComputedStyle().color` forces a style recalc WITHOUT forcing layout,
    // so this floor is style alone; `offsetHeight` would fold layout in.
    const time = (target: HTMLElement) => {
      const samples: number[] = []
      for (let index = 0; index < 5; index++) {
        target.style.setProperty("--claxedo-probe-invalidate", String(index))
        const started = performance.now()
        void getComputedStyle(document.body).color
        samples.push(performance.now() - started)
      }
      target.style.removeProperty("--claxedo-probe-invalidate")
      void getComputedStyle(document.body).color
      return Math.round(Math.min(...samples) * 100) / 100
    }
    let rules = 0
    let sheets = 0
    for (const sheet of Array.from(document.styleSheets)) {
      sheets += 1
      try {
        rules += sheet.cssRules.length
      } catch {
        // cross-origin sheet: not readable, not counted
      }
    }
    let rootCustomProperties = 0
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (!(rule instanceof CSSStyleRule)) continue
          if (rule.selectorText !== ":root" && rule.selectorText !== ":root, :host") continue
          for (const name of Array.from(rule.style)) if (name.startsWith("--")) rootCustomProperties += 1
        }
      } catch {
        // unreadable sheet
      }
    }
    const panel = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    const view = document.querySelector<HTMLElement>("[data-testid='tab-file-root']")
    return {
      sheets,
      rules,
      rootCustomProperties,
      document: { elements: countUnder(document.documentElement), ms: time(document.documentElement) },
      panel: panel ? { elements: countUnder(panel), ms: time(panel) } : undefined,
      view: view ? { elements: countUnder(view), ms: time(view) } : undefined,
    }
  })

/**
 * Whole-document style invalidation sources. A narrow DOM change dirties only
 * its own subtree; these are the writes that dirty EVERY element in a tree
 * scope, which is what a two-pass ~3200-element UpdateLayoutTree per
 * interaction looks like:
 *
 *   sheetDelta / head        a stylesheet added or removed in document scope
 *   fontLoads                a font finishing load (StyleEngine font update)
 *   rootAttributes           an attribute / custom property on <html>/<body>
 *   styleText                a <style> element's TEXT rewritten anywhere in
 *                            the document, light or shadow — invisible to a
 *                            head-only childList watch
 *   adopted                  `adoptedStyleSheets` assigned, or `replaceSync` /
 *                            `insertRule` / `deleteRule` on any sheet — none of
 *                            which change `document.styleSheets.length`
 *   media                    a media query flipping (MediaQueryAffectingValue)
 *   containerResize          a size-query container changing size
 *
 * `adopted` and `styleText` carry the JS stack that performed the write, since
 * those are the two that name application code directly.
 */
type InvalidationWatchState = {
  sheetsBefore: number
  headMutations: string[]
  rootAttributes: string[]
  styleText: string[]
  ancestorProperties: string[]
  adopted: string[]
  media: string[]
  containerResize: number
  fontLoads: number
  observers: MutationObserver[]
  stop: () => void
}

const armInvalidationWatch = async (page: Page) =>
  await page.evaluate(() => {
    const w = window as unknown as { __claxedoProbeInvalidation?: InvalidationWatchState }
    type InvalidationWatchState = {
      sheetsBefore: number
      headMutations: string[]
      rootAttributes: string[]
      styleText: string[]
      ancestorProperties: string[]
      adopted: string[]
      media: string[]
      containerResize: number
      fontLoads: number
      observers: MutationObserver[]
      stop: () => void
    }
    w.__claxedoProbeInvalidation?.stop()
    const frame = () => (new Error().stack ?? "").split("\n").slice(2, 5).join(" | ").slice(0, 300)
    const state: InvalidationWatchState = {
      sheetsBefore: document.styleSheets.length,
      headMutations: [],
      rootAttributes: [],
      styleText: [],
      ancestorProperties: [],
      adopted: [],
      media: [],
      containerResize: 0,
      fontLoads: 0,
      observers: [],
      stop: () => {},
    }
    const describe = (element: Element) =>
      `${element.tagName.toLowerCase()}` +
      `${element.id ? `#${element.id}` : ""}` +
      `${element.getAttribute("data-testid") ? `[${element.getAttribute("data-testid")}]` : ""}` +
      `${element.getAttribute("data-component") ? `{${element.getAttribute("data-component")}}` : ""}`
    const customProperties = (styleText: string) => {
      const map = new Map<string, string>()
      for (const declaration of styleText.split(";")) {
        const at = declaration.indexOf(":")
        if (at < 0) continue
        const name = declaration.slice(0, at).trim()
        if (name.startsWith("--")) map.set(name, declaration.slice(at + 1).trim())
      }
      return map
    }
    const recordMutations = (records: MutationRecord[]) => {
      for (const record of records) {
        if (record.type === "attributes") {
          const target = record.target as Element
          if (target === document.documentElement || target === document.body) {
            state.rootAttributes.push(`${target.tagName}@${record.attributeName ?? "?"}`)
          }
          // An inherited custom property written on ANY element re-resolves that
          // element's whole subtree, so a write on a high ancestor costs a
          // whole-document recalc while looking like a one-element mutation.
          if (record.attributeName === "style") {
            const descendants = target.querySelectorAll("*").length
            if (descendants >= 100) {
              const before = customProperties(record.oldValue ?? "")
              const after = customProperties(target.getAttribute("style") ?? "")
              for (const [name, value] of after) {
                if (before.get(name) === value) continue
                state.ancestorProperties.push(
                  `${describe(target)}(${descendants} els) ${name}: ${before.get(name) ?? "∅"} -> ${value}`,
                )
              }
              for (const [name] of before) {
                if (after.has(name)) continue
                state.ancestorProperties.push(`${describe(target)}(${descendants} els) ${name}: removed`)
              }
            }
          }
          continue
        }
        if (record.type === "characterData") {
          const owner = record.target.parentElement
          if (owner instanceof HTMLStyleElement) state.styleText.push(`~STYLE#${owner.id || "(anon)"}`)
          continue
        }
        // `style.textContent = css` REPLACES the text node rather than editing
        // it, so it arrives as a childList mutation whose nodes are Text — no
        // characterData record, no change to `document.styleSheets.length`, and
        // a whole-document invalidation all the same.
        if (record.target instanceof HTMLStyleElement) {
          state.styleText.push(`~STYLE#${record.target.id || "(anon)"} rewritten`)
        }
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof HTMLStyleElement || node instanceof HTMLLinkElement) {
            state.headMutations.push(`+${node.tagName}#${(node as Element).id || "(anon)"}`)
          }
        }
        for (const node of Array.from(record.removedNodes)) {
          if (node instanceof HTMLStyleElement || node instanceof HTMLLinkElement) {
            state.headMutations.push(`-${node.tagName}#${(node as Element).id || "(anon)"}`)
          }
        }
      }
    }
    // Document-wide, so a <style> rewritten deep in the tree is seen too. The
    // observer only records STYLE/LINK nodes and <html>/<body> attributes, so
    // its own cost stays bounded while covering every tree position.
    const documentObserver = new MutationObserver(recordMutations)
    documentObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["class", "style", "data-theme", "data-color-scheme"],
    })
    state.observers.push(documentObserver)

    // Constructible-stylesheet writes: none of these change
    // `document.styleSheets.length`, and all of them dirty a whole tree scope.
    const sheetProto = CSSStyleSheet.prototype as unknown as Record<string, unknown>
    const patched: Array<[Record<string, unknown>, string, unknown]> = []
    for (const name of ["replaceSync", "replace", "insertRule", "deleteRule"] as const) {
      const original = sheetProto[name] as ((...args: unknown[]) => unknown) | undefined
      if (!original) continue
      patched.push([sheetProto, name, original])
      sheetProto[name] = function (this: CSSStyleSheet, ...args: unknown[]) {
        state.adopted.push(`${name} ${frame()}`)
        return original.apply(this, args)
      }
    }
    const adoptedDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "adoptedStyleSheets")
    const shadowAdoptedDescriptor = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, "adoptedStyleSheets")
    const wrapAdopted = (target: object, descriptor: PropertyDescriptor | undefined, label: string) => {
      if (!descriptor?.set) return () => {}
      const originalSet = descriptor.set
      Object.defineProperty(target, "adoptedStyleSheets", {
        ...descriptor,
        set(this: unknown, value: unknown) {
          state.adopted.push(`${label}=[] ${frame()}`)
          originalSet.call(this, value)
        },
      })
      return () => Object.defineProperty(target, "adoptedStyleSheets", descriptor)
    }
    const restoreDocumentAdopted = wrapAdopted(Document.prototype, adoptedDescriptor, "document.adoptedStyleSheets")
    const restoreShadowAdopted = wrapAdopted(ShadowRoot.prototype, shadowAdoptedDescriptor, "shadowRoot.adoptedStyleSheets")

    // A media query flipping re-evaluates every rule in the document.
    const queries = [
      "(prefers-color-scheme: dark)",
      "(prefers-reduced-motion: reduce)",
      "(max-width: 768px)",
      "(min-width: 1024px)",
      "(pointer: coarse)",
    ].map((text) => {
      const list = window.matchMedia(text)
      const onChange = () => state.media.push(`${text}=${list.matches}`)
      list.addEventListener("change", onChange)
      return () => list.removeEventListener("change", onChange)
    })

    const onFonts = () => {
      state.fontLoads += 1
    }
    document.fonts.addEventListener("loadingdone", onFonts)

    // The layout viewport changing size re-evaluates every media query and
    // marks every element for recalc — with no DOM mutation and no
    // invalidation-tracking event to show for it. A scrollbar appearing or
    // disappearing is enough.
    let viewportFrame = 0
    const viewportSignature = () =>
      `${document.documentElement.clientWidth}x${document.documentElement.clientHeight}` +
      `/${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`
    let lastViewport = viewportSignature()
    const sampleViewport = () => {
      const signature = viewportSignature()
      if (signature !== lastViewport) {
        state.media.push(`viewport ${lastViewport} -> ${signature}`)
        lastViewport = signature
      }
      viewportFrame = requestAnimationFrame(sampleViewport)
    }
    viewportFrame = requestAnimationFrame(sampleViewport)

    state.stop = () => {
      cancelAnimationFrame(viewportFrame)
      for (const observer of state.observers) observer.disconnect()
      for (const [target, name, original] of patched) target[name] = original
      restoreDocumentAdopted()
      restoreShadowAdopted()
      for (const off of queries) off()
      document.fonts.removeEventListener("loadingdone", onFonts)
    }
    w.__claxedoProbeInvalidation = state
  })

const readInvalidationWatch = async (page: Page) =>
  await page.evaluate(() => {
    const w = window as unknown as {
      __claxedoProbeInvalidation?: {
        sheetsBefore: number
        headMutations: string[]
        rootAttributes: string[]
        styleText: string[]
        ancestorProperties: string[]
        adopted: string[]
        media: string[]
        fontLoads: number
        stop: () => void
      }
    }
    const state = w.__claxedoProbeInvalidation
    if (!state) return undefined
    state.stop()
    const unique = (values: string[]) => Array.from(new Set(values))
    return {
      sheetDelta: document.styleSheets.length - state.sheetsBefore,
      head: unique(state.headMutations).slice(0, 8),
      rootAttributes: unique(state.rootAttributes).slice(0, 8),
      styleText: unique(state.styleText).slice(0, 8),
      ancestorProperties: unique(state.ancestorProperties).slice(0, 12),
      adopted: unique(state.adopted).slice(0, 4),
      media: unique(state.media).slice(0, 4),
      fontLoads: state.fontLoads,
    }
  })

async function openFilesNavigator(page: Page) {
  const already = await page.locator("[data-testid='workspace-files-navigator'][data-mode='files']:visible").count()
  if (already) return
  await page.evaluate(() => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" &&
        style.pointerEvents !== "none"
    }
    const control = Array.from(document.querySelectorAll<HTMLElement>(
      "button[aria-label='Open Files'], [role='button'][aria-label='Open Files']",
    )).find(visible)
    if (!control) throw new Error("no visible 'Open Files' control on the workspace panel")
    control.click()
  })
  await page.waitForFunction(() => {
    const navigator = document.querySelector<HTMLElement>("[data-testid='workspace-files-navigator'][data-mode='files']")
    if (!navigator) return false
    const overlay = navigator.closest<HTMLElement>("[data-testid='workspace-navigator-overlay']")
    if (overlay && (overlay.dataset.open !== "true" || overlay.getAttribute("aria-hidden") === "true")) return false
    return navigator.getAttribute("data-file-tree-data-ready") === "true" ||
      !!navigator.querySelector("[data-file-tree-path]")
  }, undefined, { timeout: 10_000 })
}

const navigatorLocator = (page: Page) =>
  page.locator("[data-testid='workspace-files-navigator'][data-mode='files']:visible").last()

async function searchAndRow(page: Page, filePath: string): Promise<Locator> {
  await openFilesNavigator(page)
  const search = navigatorLocator(page).locator("input[placeholder='Search files...']").first()
  await search.waitFor({ state: "visible", timeout: 5_000 })
  await search.fill(filePath)
  const row = navigatorLocator(page).locator(`[data-file-tree-path="${filePath}"]`).first()
  await row.waitFor({ state: "visible", timeout: 5_000 })
  return row
}

/** Precondition helper: open a file tab and wait until its view is ready. */
async function openFileTab(page: Page, filePath: string) {
  const row = await searchAndRow(page, filePath)
  await row.click({ timeout: 5_000 })
  await page.waitForFunction((filePath) => {
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    return !!shell?.querySelector(
      `[data-testid='tab-file-root'][data-tab-file-path="${CSS.escape(filePath)}"][data-tab-file-state='ready']`,
    )
  }, filePath, { timeout: 20_000 })
}

const app = await startApp()
const fixture = fixtureFor(SCENARIO, seedForScenario(SCENARIO))
const browser = await chromium.launch({ headless: true, args: frameSamplingLaunchArgs, timeout: 30_000 })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 400)))
page.on("console", (message) => {
  if (message.type() === "error") console.log("[console error]", message.text().slice(0, 300))
})

const probeStarted = performance.now()
const elapsed = () => `${Math.round(performance.now() - probeStarted)}ms`

await installMockApi(page, app, fixture, monitorPage(page), environmentProfile("unthrottled"))
await installSeedState(page, app, fixture)

const session = fixture.sessions[0]!
console.log(`[probe] app=${app.baseUrl} mock=${app.mockPort} corpus=${fixture.changedFiles.length} files`)

await launchTo(page, app, sessionPath(session, session.id))
await waitForTranscript(page, fixture, session.id, session.title)
console.log(`[probe] home session ready (${elapsed()})`)

await openReviewSurface(page, fixture, { settle: "frame" })
await openFilesNavigator(page)
const [fileA, fileB] = WORKSPACE_INTERACTIONS_PRELOADED_FILE_PATHS
for (const filePath of WORKSPACE_INTERACTIONS_PRELOADED_FILE_PATHS) await openFileTab(page, filePath)
const precondition = await settleBeforeNextInteraction(page)
console.log(
  `[probe] panel open, ${WORKSPACE_INTERACTIONS_PRELOADED_FILE_PATHS.length} file tabs open;` +
    ` settle=${round(precondition.waitedMs)}ms settled=${precondition.settled} (${elapsed()})`,
)

const styleProfile = await readStyleProfile(page)
const per = (region: { elements: number; ms: number } | undefined) =>
  region ? `${region.ms}ms / ${region.elements} els = ${round((region.ms * 1000) / Math.max(1, region.elements))}µs per element` : "n/a"
console.log(
  `[probe] style floor: ${styleProfile.sheets} sheets, ${styleProfile.rules} rules,` +
    ` ${styleProfile.rootCustomProperties} :root custom properties`,
)
console.log(`[probe]   whole document  ${per(styleProfile.document)}`)
console.log(`[probe]   workspace panel ${per(styleProfile.panel)}`)
console.log(`[probe]   one file view   ${per(styleProfile.view)}`)

type CellResult = {
  cell: string
  metric: FrameMetric
  observation: Observation
  domBefore: Awaited<ReturnType<typeof readFileViewDom>>
  domAfter: Awaited<ReturnType<typeof readFileViewDom>>
  settleMs: number
  settled: boolean
}
const results: CellResult[] = []

const runCell = async (input: { cell: string; control: Locator; mode: Mode }): Promise<CellResult> => {
  const domBefore = await readFileViewDom(page)
  await input.control.scrollIntoViewIfNeeded().catch(() => undefined)
  await armInvalidationWatch(page)
  const prepared = await prepareTrustedInteraction(page, input.control, input.cell)
  const { metric, observation } = await measureIsolatedInteraction<Observation>(page, input.cell, async () => {
    await page.mouse.click(prepared.x, prepared.y)
    return await page.evaluate(observeFileInteraction, {
      mark: prepared.mark,
      timeoutMs: ISOLATED_INTERACTION_TIMEOUT_MS,
      mode: input.mode,
      peak: process.env.PROBE_DOM_PEAK === "1",
      cheapReady: process.env.PROBE_CHEAP_READY === "1",
    })
  })
  const invalidation = await readInvalidationWatch(page)
  const gate = await settleBeforeNextInteraction(page)
  const domAfter = await readFileViewDom(page)
  console.log(
    `[invalidation] ${input.cell.padEnd(18)} sheetDelta=${invalidation?.sheetDelta ?? "n/a"}` +
      ` fontLoads=${invalidation?.fontLoads ?? "n/a"}` +
      ` head=[${invalidation?.head.join(",") ?? ""}]` +
      ` rootAttrs=[${invalidation?.rootAttributes.join(",") ?? ""}]` +
      ` styleText=[${invalidation?.styleText.join(",") ?? ""}]` +
      ` media=[${invalidation?.media.join(",") ?? ""}]`,
  )
  for (const entry of invalidation?.ancestorProperties ?? []) {
    console.log(`[invalidation]   ancestor custom property: ${entry}`)
  }
  for (const entry of invalidation?.adopted ?? []) console.log(`[invalidation]   sheet write: ${entry}`)
  const result: CellResult = {
    cell: input.cell,
    metric,
    observation,
    domBefore,
    domAfter,
    settleMs: round(gate.waitedMs),
    settled: gate.settled,
  }
  results.push(result)
  const causal = metric.causal?.performance
  console.log(
    `[cell] ${input.cell.padEnd(18)} completion=${ms(observation.completionMs).padStart(9)}` +
      ` script=${ms(causal?.scriptMs).padStart(9)} style=${ms(causal?.recalcStyleMs).padStart(9)}` +
      ` layout=${ms(causal?.layoutMs).padStart(8)} worstFrame=${ms(metric.worstFrameMs).padStart(9)}` +
      `  (+${elapsed()})`,
  )
  return result
}

const fileTabButton = (filePath: string) =>
  page
    .locator("[data-testid='workspace-panel-shell'][data-open='true'] [data-slot='workspace-tab'][data-workspace-tab-kind='file']")
    .filter({ hasText: basename(filePath) })
    .first()
    .locator("button")
    .first()

const tabIdForFile = async (filePath: string) =>
  await page.evaluate((name) => {
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    const tabs = Array.from(
      shell?.querySelectorAll<HTMLElement>("[data-slot='workspace-tab'][data-workspace-tab-kind='file']") ?? [],
    )
    return tabs.find((tab) => (tab.textContent ?? "").includes(name))?.dataset.workspaceTabId
  }, basename(filePath))

const tabCount = async () =>
  await page.evaluate(() =>
    document.querySelectorAll("[data-testid='workspace-panel-shell'][data-open='true'] [data-slot='workspace-tab']").length)

console.log("\n=== measured file-tab interactions ===")
await runCell({
  cell: "tab_switch_to_a",
  control: fileTabButton(fileA!),
  mode: { kind: "activate-file", filePath: fileA! },
})
await runCell({
  cell: "tab_switch_to_b",
  control: fileTabButton(fileB!),
  mode: { kind: "activate-file", filePath: fileB! },
})
await runCell({
  cell: "open_file",
  control: await searchAndRow(page, WORKSPACE_INTERACTIONS_OPEN_FILE_PATH),
  mode: { kind: "activate-file", filePath: WORKSPACE_INTERACTIONS_OPEN_FILE_PATH },
})
const closeTabId = await tabIdForFile(WORKSPACE_INTERACTIONS_OPEN_FILE_PATH)
if (!closeTabId) throw new Error(`no tab id for ${WORKSPACE_INTERACTIONS_OPEN_FILE_PATH}`)
await runCell({
  cell: "close_file",
  control: page
    .locator(`[data-testid='workspace-tab-close'][data-workspace-tab-id="${closeTabId}"]`)
    .locator("button")
    .first(),
  mode: { kind: "close-tab", tabId: closeTabId, openTabsBefore: await tabCount() },
})
await runCell({
  cell: "open_large_file",
  control: await searchAndRow(page, WORKSPACE_INTERACTIONS_LARGE_FILE_PATH),
  mode: { kind: "activate-file", filePath: WORKSPACE_INTERACTIONS_LARGE_FILE_PATH },
})

console.log(`\n================ RESULTS (target: every metric < ${TARGET_MS}ms) ================`)
for (const result of results) {
  const causal = result.metric.causal?.performance
  const verdict = result.observation.completionMs < TARGET_MS ? "PASS" : "OVER"
  console.log(
    `  ${verdict}  ${result.cell.padEnd(18)} completion=${ms(result.observation.completionMs).padStart(9)}` +
      ` ack=${ms(result.observation.acknowledgedMs).padStart(9)}` +
      ` script=${ms(causal?.scriptMs).padStart(9)} style=${ms(causal?.recalcStyleMs).padStart(9)}` +
      ` layout=${ms(causal?.layoutMs).padStart(8)} task=${ms(causal?.taskMs).padStart(9)}` +
      ` worstFrame=${ms(result.metric.worstFrameMs).padStart(9)}` +
      ` framesOver16=${result.metric.framesOver1667}` +
      ` settle=${result.settleMs}ms${result.settled ? "" : " (UNSETTLED)"}`,
  )
}

console.log("\n-- DOM weight of the mounted file views (after each interaction) --")
for (const result of results) {
  const dom = result.domAfter
  const detail = dom.views
    .map((view) => `${basename(view.path)}[lines=${view.contentLines} shadowRows=${view.lines} shadowEls=${view.elements} lightEls=${view.lightElements}]`)
    .join(" ")
  console.log(
    `  ${result.cell.padEnd(18)} mountedViews ${result.domBefore.mountedFileViews}->${dom.mountedFileViews}` +
      ` panelEls ${result.domBefore.panelElements}->${dom.panelElements}` +
      ` docEls ${result.domBefore.documentElements}->${dom.documentElements}` +
      (result.observation.peakElements === undefined
        ? ""
        : ` peak ${result.observation.peakElements}light/${result.observation.peakShadowElements}shadow`) +
      ` shadowEls ${result.domBefore.documentShadowElements}->${dom.documentShadowElements}` +
      ` fullRecalc ${dom.fullRecalcMs}ms  ${detail || "(none mounted)"}`,
  )
}

console.log("\n-- per-cell causal detail --")
for (const result of results) {
  const causal = result.metric.causal
  console.log(`\n  ${result.cell}`)
  if (!causal) {
    console.log("    no causal capture; set CLAXEDO_PERF_CAUSAL=1")
    continue
  }
  console.log(`    source                  ${causal.performanceSource ?? "unknown"}${causal.performanceUnavailableReason ? ` (${causal.performanceUnavailableReason})` : ""}`)
  console.log(`    DOM                     +${causal.dom.nodesAdded} nodes / -${causal.dom.nodesRemoved} nodes / ${causal.dom.attributesChanged} attrs`)
  const resources = causal.resources.filter((resource) => !resource.name.startsWith("data:"))
  console.log(`    resource requests       ${resources.length}`)
  const longTasks = (result.metric.mainThreadTasksMs ?? []).filter((value) => value > RENDERER_DEADLINE_MS)
  console.log(`    tasks > 16.67ms         ${longTasks.length}: [${longTasks.map(round).join(", ")}]`)
  for (const phase of causal.rendererPhases ?? []) {
    if (phase.durationMs >= 5) console.log(`    renderer phase          ${phase.name}: ${phase.durationMs}ms`)
  }
  for (const task of (causal.traceTasks ?? []).filter((task) => task.durationMs > RENDERER_DEADLINE_MS).slice(0, 4)) {
    console.log(`    trace task ${task.durationMs}ms`)
    for (const event of task.events.slice(0, 8)) {
      console.log(`        ${String(event.durationMs).padStart(8)}ms  ${event.name}${event.detail ? ` :: ${event.detail}` : ""}`)
    }
  }
}

// Where the floor lives, measured in the state the cells above actually pay
// for (a file tab open). Each region is display-locked in turn and the
// whole-document floor re-timed: the saving is that region's share of every
// style recalculation the interactions perform.
console.log("\n-- floor composition in the file-open state (display-lock one region, re-time the floor) --")
const floorRegion = async (selector: string | null) =>
  await page.evaluate((value) => {
    const targets = value ? Array.from(document.querySelectorAll<HTMLElement>(value)) : []
    let covered = 0
    for (const target of targets) {
      covered += target.querySelectorAll("*").length
      target.style.contentVisibility = "hidden"
    }
    const samples: number[] = []
    for (let index = 0; index < 15; index++) {
      document.documentElement.style.setProperty("--claxedo-floor-probe", String(index))
      const started = performance.now()
      void getComputedStyle(document.body).color
      samples.push(performance.now() - started)
    }
    document.documentElement.style.removeProperty("--claxedo-floor-probe")
    void getComputedStyle(document.body).color
    for (const target of targets) target.style.removeProperty("content-visibility")
    void getComputedStyle(document.body).color
    samples.sort((a, b) => a - b)
    return { min: samples[0]!, count: targets.length, covered }
  }, selector)
const floorBase = await floorRegion(null)
console.log(`  whole document                                   floor=${round(floorBase.min)}ms`)
for (const selector of [
  "svg[id$='-icon-sprite']",
  "[data-testid='tab-file-root']",
  "[data-testid='workspace-panel-shell']",
  "[data-component='session-prompt-dock']",
  "[data-component='icon']",
  "[data-component='tooltip-trigger']",
  "#review-panel",
  "nav",
]) {
  const region = await floorRegion(selector)
  console.log(
    `  ${selector.padEnd(46)} n=${String(region.count).padStart(4)} els=${String(region.covered).padStart(5)}` +
      ` floor=${String(round(region.min)).padStart(6)}ms  saves ${round(floorBase.min - region.min)}ms`,
  )
}

console.log(`\n[probe] total runtime ${elapsed()}`)

await browser.close()
await stopApp(app)
process.exit(0)
