// TEMP probe (read-only diagnosis): price each selector FAMILY by removing it
// from the document and re-timing the whole-document style pass.
//
// `debug-selector-stats.ts` names the families structurally: 347k of the ~460k
// selector match attempts in one whole-document recalc are in the `[data-slot]`
// bucket, because Blink buckets attribute rules by attribute NAME — so each of
// the ~407 elements carrying `data-slot` is tried against all ~857 `data-slot`
// selectors. But that probe runs under `blink.debug` tracing, which adds
// per-attempt instrumentation and therefore inflates exactly the families with
// the most attempts. Its µs column cannot be used to size a fix.
//
// This probe measures the same families WITHOUT tracing. It re-serialises the
// document's stylesheets from the CSSOM, applies one transformation, swaps the
// result in for the originals, and times the floor — paired and interleaved
// against a control that is the SAME re-serialisation with no transformation,
// so sheet-injection and parse effects cancel and only the transformation is
// measured.
//
// The important variant is `slot-to-class`: it does not delete anything. It
// rewrites every rightmost `[data-slot="x"]` compound to `.cxslot-x` and adds
// the matching class to every element that carries that `data-slot` value.
// Same declarations, same specificity (0,1,0 either way), same cascade order —
// only the RULE BUCKET changes, from one 857-rule attribute-name bucket to ~200
// class-name buckets that each element only enters if it actually has the class.
// That is the proposed source fix, measured before any source is touched.
//
// Run:
//   cd packages/claxedo-app/perf-harness
//   CLAXEDO_PERF_SKIP_BUILD=1 CLAXEDO_PERF_MOCK_PORT=<baked> bun probes/debug-selector-surgery.ts
import { chromium } from "@playwright/test"

import { frameSamplingLaunchArgs } from "../src/frame-sampler"
import { fixtureFor } from "../src/browser/fixtures"
import { installMockApi } from "../src/browser/mock-api"
import { installSeedState, sessionPath } from "../src/browser/state"
import { launchTo } from "../src/browser/actions/common"
import { monitorPage } from "../src/browser/page-validation"
import { openReviewSurface } from "../src/browser/actions/review"
import { startApp, stopApp } from "../src/browser/environment"
import { waitForTranscript } from "../src/browser/actions/session"
import { environmentProfile } from "../src/environment-profile"
import { settleBeforeNextInteraction } from "../src/isolated-interaction"
import { seedForScenario } from "../src/seed"

const SCENARIO = "workspace-interactions" as const
const round = (value: number) => Math.round(value * 100) / 100
const ROUNDS = Number(process.env.PROBE_ROUNDS ?? 9)
const SHOT_DIR = process.env.PROBE_SHOT_DIR ?? "/tmp/claxedo-selector-surgery"

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

// ---------------------------------------------------------------------------
// Install the surgery kit: CSSOM re-serialisation + the family transformations.
// ---------------------------------------------------------------------------
await page.evaluate(() => {
  const w = window as unknown as Record<string, unknown>

  const rightmostCut = (sel: string): number => {
    let depth = 0
    let bracket = 0
    let quote = ""
    let cut = 0
    for (let index = 0; index < sel.length; index++) {
      const ch = sel[index]!
      if (quote) {
        if (ch === quote && sel[index - 1] !== "\\") quote = ""
        continue
      }
      if (ch === '"' || ch === "'") { quote = ch; continue }
      if (ch === "(") depth++
      else if (ch === ")") depth--
      else if (ch === "[") bracket++
      else if (ch === "]") bracket--
      else if (depth === 0 && bracket === 0 && (ch === " " || ch === ">" || ch === "+" || ch === "~")) cut = index + 1
    }
    return cut
  }

  const splitList = (sel: string): string[] => {
    const out: string[] = []
    let depth = 0
    let bracket = 0
    let quote = ""
    let cur = ""
    for (let index = 0; index < sel.length; index++) {
      const ch = sel[index]!
      if (quote) { cur += ch; if (ch === quote && sel[index - 1] !== "\\") quote = ""; continue }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
      if (ch === "(") depth++
      else if (ch === ")") depth--
      else if (ch === "[") bracket++
      else if (ch === "]") bracket--
      if (ch === "," && depth === 0 && bracket === 0) { out.push(cur.trim()); cur = ""; continue }
      cur += ch
    }
    if (cur.trim()) out.push(cur.trim())
    return out
  }

  /** Shape of the rightmost compound — what decides the Blink rule bucket. */
  const shapeOf = (sel: string): string => {
    const rc = sel.slice(rightmostCut(sel))
    if (/^\*/.test(rc)) return "universal"
    if (/^:is\(|^:where\(/.test(rc)) return "is-where"
    if (/^:has\(/.test(rc)) return "has"
    if (/^:not\(/.test(rc)) return "not"
    if (/^:/.test(rc)) return "pseudo"
    if (/^#/.test(rc)) return "id"
    if (/^\./.test(rc)) return "class"
    if (/^\[/.test(rc)) return `attr:${/^\[([-\w]+)/.exec(rc)?.[1] ?? "?"}`
    return `tag:${/^([-\w]+)/.exec(rc)?.[1] ?? "?"}`
  }

  /**
   * Blink's universal bucket, as the SelectorStats trace defines it: a rule lands
   * there when its rightmost compound offers no id / class / attribute-name / tag
   * key to bucket by. Blink does NOT look inside `:is()` / `:where()` / `:not()`
   * to find one — the trace shows `.ui-card :where([data-card="title"], …)` and
   * `:where(.space-y-1 > :not(:last-child))` attempted against every element in
   * the recalc scope, exactly like `*`.
   */
  const isUniversalBucket = (sel: string): boolean => /^[*:]/.test(sel.slice(rightmostCut(sel)))

  /**
   * Universal-bucket rules that no source change can move: Tailwind preflight's
   * `*`, and the pseudo-elements the page has to keep styling.
   */
  const isImmovableUniversal = (sel: string): boolean => {
    const rc = sel.slice(rightmostCut(sel))
    if (/^\*$/.test(rc)) return true
    return /^::/.test(rc)
  }

  /**
   * `head:is(a, b)suffix` -> `head a suffix, head b suffix`, when the functional
   * pseudo LEADS the rightmost compound (the position that decides the bucket).
   * Returns the selector unchanged when it does not apply.
   */
  const splitRightmostList = (sel: string, fn: string, rewrap = false): string => {
    const cut = rightmostCut(sel)
    const head = sel.slice(0, cut)
    const rc = sel.slice(cut)
    if (!rc.startsWith(fn)) return sel
    let depth = 0
    let close = -1
    for (let i = fn.length - 1; i < rc.length; i++) {
      if (rc[i] === "(") depth++
      else if (rc[i] === ")") {
        depth--
        if (depth === 0) { close = i; break }
      }
    }
    if (close < 0) return sel
    const branches = splitList(rc.slice(fn.length, close))
    const suffix = rc.slice(close + 1)
    if (branches.length === 0) return sel
    if (branches.length === 1 && !rewrap) return sel
    return branches.map((branch) => `${head}${rewrap ? `${fn}${branch})` : branch}${suffix}`).join(",")
  }

  const sanitize = (value: string) => value.replaceAll(/[^\w-]/g, "-")

  // Rewrite a rightmost [data-slot="x"] / [data-component="x"] into a class.
  const attrToClass = (sel: string, attribute: string, prefix: string, seen: Set<string>): string => {
    const cut = rightmostCut(sel)
    const head = sel.slice(0, cut)
    let rc = sel.slice(cut)
    const pattern = new RegExp(`\\[${attribute}=(?:"([^"]*)"|'([^']*)'|([^\\]]*))\\]`)
    const match = pattern.exec(rc)
    if (!match || match.index !== 0) return sel
    const value = match[1] ?? match[2] ?? match[3] ?? ""
    if (!value) return sel
    const token = `${prefix}${sanitize(value)}`
    seen.add(`${value} ${token}`)
    rc = `.${token}${rc.slice(match[0].length)}`
    return head + rc
  }

  type Transform = {
    // return null to DROP the selector entirely
    selector: (sel: string, seen: Set<string>) => string | null
  }

  const transforms: Record<string, Transform> = {
    control: { selector: (sel) => sel },
    "drop-slot": { selector: (sel) => (shapeOf(sel) === "attr:data-slot" ? null : sel) },
    "drop-component": { selector: (sel) => (shapeOf(sel) === "attr:data-component" ? null : sel) },
    "drop-universal-bucket": {
      selector: (sel) => (["universal", "is-where", "has", "not", "pseudo"].includes(shapeOf(sel)) ? null : sel),
    },
    // `drop-universal-bucket` also deletes every `:root` rule, and `:root` is
    // where all the custom properties are defined. That does not just change
    // match volume, it changes what the whole cascade has to resolve. The three
    // variants below separate the two effects.
    "drop-root-only": { selector: (sel) => (sel.trim() === ":root" ? null : sel) },
    // Preflight and UA pseudo-elements are in the universal bucket too, but no
    // source change can move them — they are measured, never converted.
    "drop-universal-app": { selector: (sel) => (isUniversalBucket(sel) && !isImmovableUniversal(sel) ? null : sel) },
    "drop-universal-all": { selector: (sel) => (isUniversalBucket(sel) ? null : sel) },
    // The family this lane was sent to convert: Tailwind's `space-y-*` /
    // `divide-*`, which compile to `:where(.space-y-1 > :not(:last-child))`.
    "drop-spacey-divide": { selector: (sel) => (/:where\(\.(?:space-[xy]-|divide-)/.test(sel) ? null : sel) },
    // Not an ablation — the proposed fix, measured before any source is touched.
    // `a :is(x, y)` and `a x, a y` match exactly the same elements, and `:is()`
    // takes the specificity of its most specific argument, so when the branches
    // are equally specific the split is cascade-neutral too. What changes is the
    // bucket: the rightmost compound stops being `:is(` and becomes a real tag /
    // class / attribute key, so the rule leaves the universal bucket.
    "split-rightmost-is": { selector: (sel) => splitRightmostList(sel, ":is(") },
    // Same shape, but `:where()` is specificity-zero, so splitting it RAISES
    // specificity. Measured separately and never shipped blind.
    "split-rightmost-where": { selector: (sel) => splitRightmostList(sel, ":where(") },
    // THE PROPOSED SOURCE FIX. Same split, except each branch is wrapped back in
    // the pseudo it came from, so a `:where()` stays specificity-zero and the
    // rule's specificity is byte-for-byte what it was. Blink extracts a bucket
    // key from a SINGLE-argument `:is()`/`:where()` but not from a multi-argument
    // one — which is why `:where([data-slot="card-title"])` never reaches the
    // attempt ceiling while `:where([data-card="title"], [data-slot="card-title"])`
    // does — so one-branch-per-part is enough to leave the universal bucket.
    "split-rightmost-keep-spec": {
      selector: (sel) => splitRightmostList(splitRightmostList(sel, ":is(", true), ":where(", true),
    },
    "drop-bare-tag": { selector: (sel) => (shapeOf(sel).startsWith("tag:") ? null : sel) },
    "drop-has": { selector: (sel) => (/:has\(/.test(sel) ? null : sel) },
    "slot-to-class": {
      selector: (sel, seen) => (shapeOf(sel) === "attr:data-slot" ? attrToClass(sel, "data-slot", "cxslot-", seen) : sel),
    },
    "slot+component-to-class": {
      selector: (sel, seen) => {
        const shape = shapeOf(sel)
        if (shape === "attr:data-slot") return attrToClass(sel, "data-slot", "cxslot-", seen)
        if (shape === "attr:data-component") return attrToClass(sel, "data-component", "cxcomp-", seen)
        return sel
      },
    },
  }

  /** Re-serialise a rule tree, applying `transform` to every style rule's selector. */
  const serialize = (rules: CSSRuleList, transform: Transform, seen: Set<string>): string => {
    let out = ""
    for (const rule of Array.from(rules)) {
      const kind = rule.constructor.name
      const nested = (rule as unknown as { cssRules?: CSSRuleList }).cssRules
      if (kind === "CSSStyleRule") {
        const styleRule = rule as CSSStyleRule
        const kept: string[] = []
        for (const one of splitList(styleRule.selectorText)) {
          const mapped = transform.selector(one, seen)
          if (mapped) kept.push(mapped)
        }
        if (kept.length === 0) continue
        const decls = styleRule.style.cssText
        const inner = nested && nested.length > 0 ? serialize(nested, transform, seen) : ""
        if (!decls && !inner) continue
        out += `${kept.join(",")}{${decls}${inner ? `;${inner}` : ""}}`
        continue
      }
      if (kind === "CSSMediaRule" || kind === "CSSSupportsRule" || kind === "CSSContainerRule") {
        const at = kind === "CSSMediaRule" ? "@media" : kind === "CSSSupportsRule" ? "@supports" : "@container"
        const condition = (rule as unknown as { conditionText: string }).conditionText
        const inner = nested ? serialize(nested, transform, seen) : ""
        if (inner) out += `${at} ${condition}{${inner}}`
        continue
      }
      if (kind === "CSSLayerBlockRule") {
        const name = (rule as unknown as { name: string }).name
        const inner = nested ? serialize(nested, transform, seen) : ""
        out += `@layer ${name}{${inner}}`
        continue
      }
      if (kind === "CSSScopeRule") {
        const inner = nested ? serialize(nested, transform, seen) : ""
        const prelude = (rule as unknown as { start?: string; end?: string })
        const start = prelude.start ? `(${prelude.start})` : ""
        const end = prelude.end ? ` to (${prelude.end})` : ""
        if (inner) out += `@scope ${start}${end}{${inner}}`
        continue
      }
      // @keyframes, @property, @font-face, @layer statements, @import, ...
      out += rule.cssText
    }
    return out
  }

  const sheetNodes = () =>
    Array.from(document.styleSheets).filter((sheet) => {
      try {
        void sheet.cssRules
        return true
      } catch {
        return false
      }
    })

  w.__surgery = {
    /** Build the variant text once; returns stats. */
    build: (name: string) => {
      const transform = transforms[name]!
      const seen = new Set<string>()
      let text = ""
      for (const sheet of sheetNodes()) text += serialize(sheet.cssRules, transform, seen)
      const classes = Array.from(seen).map((entry) => entry.split(" ") as [string, string])
      const store = w as unknown as Record<string, unknown>
      store[`__variant_${name}`] = { text, classes }
      return { bytes: text.length, classAdds: classes.length }
    },
    /**
     * Time the floor with the variant installed and with the ORIGINAL sheets
     * installed, back to back, `rounds` times; report the median paired delta.
     * Everything the transformation does — including the added classes — is
     * inside the paired region, so machine drift cancels.
     */
    measure: async (name: string, rounds: number) => {
      const store = w as unknown as Record<string, unknown>
      const variant = store[`__variant_${name}`] as { text: string; classes: Array<[string, string]> }
      const style = document.createElement("style")
      style.id = "claxedo-surgery"
      style.textContent = variant.text
      document.head.append(style)
      const originals = sheetNodes().filter((sheet) => sheet.ownerNode !== style)

      // Elements that must gain a class for the rewritten selectors to match.
      const adds: Array<{ node: Element; token: string }> = []
      for (const [value, token] of variant.classes) {
        for (const node of Array.from(document.querySelectorAll(`[data-slot="${CSS.escape(value)}"]`))) {
          if (token.startsWith("cxslot-")) adds.push({ node, token })
        }
        for (const node of Array.from(document.querySelectorAll(`[data-component="${CSS.escape(value)}"]`))) {
          if (token.startsWith("cxcomp-")) adds.push({ node, token })
        }
      }

      const time = (samples: number) => {
        const values: number[] = []
        for (let index = 0; index < samples; index++) {
          document.documentElement.style.setProperty("--claxedo-surgery-probe", String(index))
          const started = performance.now()
          void getComputedStyle(document.body).color
          values.push(performance.now() - started)
        }
        document.documentElement.style.removeProperty("--claxedo-surgery-probe")
        void getComputedStyle(document.body).color
        values.sort((a, b) => a - b)
        return values[0]!
      }

      const on = () => {
        for (const sheet of originals) sheet.disabled = true
        style.disabled = false
        for (const { node, token } of adds) node.classList.add(token)
      }
      const off = () => {
        for (const { node, token } of adds) node.classList.remove(token)
        style.disabled = true
        for (const sheet of originals) sheet.disabled = false
      }

      const deltas: number[] = []
      const variants: number[] = []
      const bases: number[] = []
      for (let round = 0; round < rounds; round++) {
        off()
        const base = time(5)
        on()
        const withVariant = time(5)
        deltas.push(base - withVariant)
        bases.push(base)
        variants.push(withVariant)
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      off()
      style.remove()
      void getComputedStyle(document.body).color
      const median = (list: number[]) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]!
      deltas.sort((a, b) => a - b)
      return {
        saved: median(deltas),
        low: deltas[0]!,
        high: deltas[deltas.length - 1]!,
        base: median(bases),
        variant: median(variants),
        elements: document.querySelectorAll("*").length,
        classAdds: adds.length,
      }
    },
    /** Install a variant persistently (for screenshots). */
    install: (name: string) => {
      const store = w as unknown as Record<string, unknown>
      const variant = store[`__variant_${name}`] as { text: string; classes: Array<[string, string]> }
      const style = document.createElement("style")
      style.id = "claxedo-surgery-installed"
      style.textContent = variant.text
      document.head.append(style)
      for (const sheet of sheetNodes()) if (sheet.ownerNode !== style) sheet.disabled = true
      for (const [value, token] of variant.classes) {
        if (token.startsWith("cxslot-")) {
          for (const node of Array.from(document.querySelectorAll(`[data-slot="${CSS.escape(value)}"]`))) node.classList.add(token)
        } else {
          for (const node of Array.from(document.querySelectorAll(`[data-component="${CSS.escape(value)}"]`))) node.classList.add(token)
        }
      }
    },
    uninstall: (name: string) => {
      const store = w as unknown as Record<string, unknown>
      const variant = store[`__variant_${name}`] as { text: string; classes: Array<[string, string]> }
      for (const [value, token] of variant.classes) {
        if (token.startsWith("cxslot-")) {
          for (const node of Array.from(document.querySelectorAll(`[data-slot="${CSS.escape(value)}"]`))) node.classList.remove(token)
        } else {
          for (const node of Array.from(document.querySelectorAll(`[data-component="${CSS.escape(value)}"]`))) node.classList.remove(token)
        }
      }
      document.getElementById("claxedo-surgery-installed")?.remove()
      for (const sheet of sheetNodes()) sheet.disabled = false
    },
    census: () => {
      const buckets = new Map<string, number>()
      const walk = (rules: CSSRuleList) => {
        for (const rule of Array.from(rules)) {
          const nested = (rule as unknown as { cssRules?: CSSRuleList }).cssRules
          if (rule.constructor.name === "CSSStyleRule") {
            for (const one of splitList((rule as CSSStyleRule).selectorText)) {
              const shape = shapeOf(one)
              buckets.set(shape, (buckets.get(shape) ?? 0) + 1)
            }
          }
          if (nested) walk(nested)
        }
      }
      for (const sheet of sheetNodes()) walk(sheet.cssRules)
      return Array.from(buckets.entries()).sort((a, b) => b[1] - a[1])
    },
  }
})

const census = await page.evaluate(() => {
  const w = window as unknown as { __surgery: { census: () => Array<[string, number]> } }
  return {
    shapes: w.__surgery.census(),
    total: document.querySelectorAll("*").length,
    dataSlot: document.querySelectorAll("[data-slot]").length,
    dataComponent: document.querySelectorAll("[data-component]").length,
    classed: document.querySelectorAll("[class]").length,
  }
})
console.log(
  `document: ${census.total} elements — ${census.classed} with class, ${census.dataSlot} with data-slot,` +
    ` ${census.dataComponent} with data-component`,
)
console.log("\n=== live CSSOM selector census (rightmost-compound bucket) ===")
for (const [shape, count] of census.shapes.slice(0, 18)) {
  console.log(`  ${shape.padEnd(24)} ${String(count).padStart(6)} selectors`)
}

const VARIANTS = (process.env.PROBE_VARIANTS ?? [
  "control",
  "drop-slot",
  "drop-component",
  "drop-universal-bucket",
  "drop-bare-tag",
  "drop-has",
  "slot-to-class",
  "slot+component-to-class",
].join(",")).split(",").map((one) => one.trim()).filter(Boolean)

console.log(`\n=== paired family pricing (${ROUNDS} interleaved rounds each) ===`)
console.log(
  "variant".padEnd(26) + "saved".padStart(9) + "  " + "base".padStart(8) + "  " + "variant".padStart(8) +
    "  " + "µs/el saved".padStart(12) + "  spread",
)
for (const name of VARIANTS) {
  const built = await page.evaluate((variant) => {
    const w = window as unknown as { __surgery: { build: (n: string) => { bytes: number; classAdds: number } } }
    return w.__surgery.build(variant)
  }, name)
  const measured = await page.evaluate(
    ({ variant, rounds }) => {
      const w = window as unknown as {
        __surgery: {
          measure: (n: string, r: number) => Promise<{
            saved: number; low: number; high: number; base: number; variant: number; elements: number; classAdds: number
          }>
        }
      }
      return w.__surgery.measure(variant, rounds)
    },
    { variant: name, rounds: ROUNDS },
  )
  console.log(
    name.padEnd(26) +
      `${round(measured.saved)}ms`.padStart(9) +
      "  " + `${round(measured.base)}ms`.padStart(8) +
      "  " + `${round(measured.variant)}ms`.padStart(8) +
      "  " + `${round((measured.saved * 1000) / Math.max(1, measured.elements))}µs`.padStart(12) +
      `  [${round(measured.low)}..${round(measured.high)}]` +
      `  (${(built.bytes / 1024).toFixed(0)}KB, ${measured.classAdds} class adds)`,
  )
}

// --- visual parity for the proposed fix -------------------------------------
if (!VARIANTS.includes("slot-to-class")) {
  await browser.close()
  await stopApp(app)
  process.exit(0)
}
console.log("\n=== visual parity: slot-to-class ===")
await page.screenshot({ path: `${SHOT_DIR}/before.png`, fullPage: false })
await page.evaluate(() => {
  const w = window as unknown as { __surgery: { install: (n: string) => void } }
  w.__surgery.install("slot-to-class")
})
await page.waitForTimeout(250)
await page.screenshot({ path: `${SHOT_DIR}/after-slot-to-class.png`, fullPage: false })
await page.evaluate(() => {
  const w = window as unknown as { __surgery: { uninstall: (n: string) => void } }
  w.__surgery.uninstall("slot-to-class")
})
console.log(`  ${SHOT_DIR}/before.png vs ${SHOT_DIR}/after-slot-to-class.png`)

await browser.close()
await stopApp(app)
process.exit(0)
