/**
 * End-to-end verification that ```mermaid fences actually reach the mermaid
 * renderer — the WIRING, not the sanitizer.
 *
 * WHY THIS EXISTS
 * `renderMermaidBlocks` (src/components/markdown.tsx) was dead code: no diagram
 * ever rendered, and nothing caught it. The only coverage on that path was
 * `markdown-svg-sanitize.test.ts` + `verify-mermaid-svg-sanitizer.mjs`, which
 * exercise `sanitizeSvg` in isolation and never check that the renderer is
 * reached at all — a sanitizer can stay perfectly green while the code that
 * feeds it is unreachable. Two wiring bugs were behind it:
 *
 *   1. markdown.tsx `updateBlock` returned from the `mode === "code"` branch
 *      before `decorate()`, and a top-level ```mermaid fence is *always* a
 *      `mode: "code"` block, so top-level fences never reached the renderer.
 *   2. shiki's `codeToHtml` drops the `class="language-X"` that
 *      `renderMermaidBlocks` matches on, so fences nested in list items and
 *      blockquotes (which take the `mode: "full"` marked+marked-shiki path in
 *      packages/ui/src/context/marked.tsx) were unidentifiable.
 *
 * Both are invisible to any check that does not drive the real component.
 *
 * WHY THIS IS NOT A UNIT TEST
 * Same reason as verify-mermaid-svg-sanitizer.mjs: this package's runner
 * (`bun test`) has no DOM, and happy-dom cannot stand in — its HTML parser drops
 * every child of an `<svg>`, and its XML parser makes DOMPurify a no-op (see the
 * header of markdown-svg-sanitize.test.ts). On top of that, `markdown-worker.ts`
 * imports `./markdown-shiki.worker.ts?worker&url`, a Vite-only specifier, so the
 * component cannot even be loaded outside a Vite graph. Hence: a real Vite dev
 * server, real Chromium, the real `<Markdown>` component, real marked + shiki +
 * DOMPurify + mermaid.
 *
 * WHAT IS ASSERTED
 *  - Every fence shape that must render a diagram does: top-level, surrounded by
 *    prose, `~~~` tilde fence, extra info-string words, nested in a list item,
 *    nested in a blockquote, and one fed progressively with `streaming={true}`.
 *  - Negative controls that must NOT render: a ```ts fence, and inline
 *    `mermaid` code.
 *  - Per case: exactly one `[data-slot="mermaid-diagram"] svg`,
 *    `data-mermaid-state="rendered"`, the source `<pre>` computed to
 *    `display: none`, and the diagram's node labels present.
 *  - Renderer call accounting: total calls === diagram count (an ungated call
 *    fires on every streamed token), and no call ever received a partial fence.
 *  - Adversarial: a renderer that returns a hostile SVG still lands a benign
 *    diagram in the DOM (so the path is proven exercised) while nothing executes
 *    and none of the payload survives.
 *
 * Run:  bun run packages/session-ui/script/verify-mermaid-wiring.mjs
 * Or:   cd packages/session-ui && bun run verify:mermaid   (runs both scripts)
 * CI:   the linux `unit` leg of .github/workflows/test.yml.
 * Set MERMAID_WIRING_DEBUG=1 to dump what each streamed chunk put in the DOM.
 *
 * Playwright's browsers, vite, vite-plugin-solid and mermaid resolve out of
 * packages/claxedo-app, which is where this repo keeps them.
 *
 * PROVEN TO CATCH THE BUG, not just to pass: reverting each fix in turn produces
 * a distinct, legible failure —
 *   markdown.tsx's renderMermaidBlocks call removed -> the 6 top-level fence
 *     cases fail, both nested cases still pass, 2/8 renderer calls;
 *   marked.tsx's languageClass transformer removed -> only the 2 nested cases
 *     fail, each reporting "0 code block(s) carried language-mermaid", 6/8 calls;
 *   the `block.complete` gate removed -> the streaming case fires 6 times for one
 *     diagram and the partial fence bodies are named in the report.
 * Re-check that when changing this file: a guard that cannot fail is not a guard.
 */
import { createRequire } from "node:module"
import { mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE = resolve(HERE, "..")
const REPO = resolve(PACKAGE, "../..")
const APP = resolve(PACKAGE, "../claxedo-app")

const require_ = createRequire(join(APP, "package.json"))
const { chromium } = await import(require_.resolve("playwright-core"))
const { createServer } = await import(require_.resolve("vite"))
const solid = (await import(require_.resolve("vite-plugin-solid"))).default
const MERMAID_PACKAGE = resolve(dirname(require_.resolve("mermaid/package.json")))

// Generated, not committed: the fixture is written fresh on every run and removed
// in the `finally` below, exactly like verify-mermaid-svg-sanitizer.mjs's entry.
const ROOT = join(HERE, ".mermaid-wiring")

// MERMAID_WIRING_DEBUG=1 dumps what each streamed chunk actually put in the DOM.
// The streaming case is the one that is easy to break into a silent no-op, so
// keep a way to see it.
const DEBUG = process.env.MERMAID_WIRING_DEBUG === "1"

// ---- fixture ----------------------------------------------------------------

const INDEX_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>mermaid wiring</title></head>
  <body style="margin:0;background:#181818;color:#e6e6e6">
    <div id="app"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
`

// NB: `@opencode-ai/session-ui/markdown` and `mermaid` resolve through the
// node_modules symlinks created below, so this imports the package exactly the
// way the app does — through the export map, not a relative path into src.
// The CSS is the exception: the `./*` export maps to `.tsx`, so
// `@opencode-ai/session-ui/markdown.css` does NOT resolve and the stylesheet has
// to come in by relative path. It is load-bearing here: the assertion that the
// source `<pre>` is hidden is a computed-style assertion, so the real rule has
// to be in the document.
const MAIN_TSX = `import { batch, createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import { Markdown, setMermaidRenderer } from "@opencode-ai/session-ui/markdown"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import mermaid from "mermaid"
import "../../src/components/markdown.css"

const fired: string[] = []
;(window as any).__fired = fired

// Initialize mermaid EXACTLY ONCE, behind a memoized module promise — the same
// shape as packages/claxedo-app/src/features/session/ui/mermaid-timeline.ts.
// Calling initialize() per invocation races concurrent renders and yields empty
// diagrams; that was a harness artifact that cost real debugging time once.
let ready: Promise<typeof mermaid> | null = null
function getMermaid() {
  if (!ready) {
    ready = Promise.resolve().then(() => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: "base",
        // Mirrors the app: HTML labels off, so mermaid emits native <text>.
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
      })
      return mermaid
    })
  }
  return ready
}

// Spliced into a REAL mermaid SVG, so a benign diagram is still there to render:
// if the hostile case came back empty we would be asserting against nothing.
const HOSTILE =
  '<script>window.__fired.push("script-tag")<' + '/script>' +
  '<rect width="5" height="5" onload="window.__fired.push(\\'onload\\')"/>' +
  '<image href="https://evil.example/probe.png" onerror="window.__fired.push(\\'onerror\\')"/>' +
  // Deliberately no <text> child: an inert <a> is something DOMPurify legitimately
  // KEEPS after dropping the javascript: URL, and a surviving <text> would show up
  // in the label assertions as diagram content it is not.
  '<a href="javascript:window.__fired.push(\\'js-href\\')">go</a>' +
  '<foreignObject width="200" height="50"><div xmlns="http://www.w3.org/1999/xhtml">' +
  'HOSTILE_LEAK<img src="https://evil.example/pixel.png" onerror="window.__fired.push(\\'fo-img\\')"></div></foreignObject>' +
  '<style>@import url("https://evil.example/x.css");</style>'

type Call = { case: string; source: string }
const calls: Call[] = []
let current = "none"
let hostile = false
let counter = 0

setMermaidRenderer(async (source: string) => {
  calls.push({ case: current, source })
  const m = await getMermaid()
  const { svg } = await m.render("verify-" + ++counter, source)
  return hostile ? svg.replace("</svg>", HOSTILE + "</svg>") : svg
})

const [text, setText] = createSignal("")
const [streaming, setStreaming] = createSignal(false)
// Bumping the nonce remounts <Markdown> so each case starts from a clean
// component; changing only text() keeps the instance, which is what a real
// stream does.
const [nonce, setNonce] = createSignal(0)

function App() {
  return (
    <MarkedProvider>
      <Show when={nonce()} keyed>
        {(id) => <Markdown text={text()} streaming={streaming()} cacheKey={"case-" + id} />}
      </Show>
    </MarkedProvider>
  )
}

render(() => <App />, document.getElementById("app")!)

;(window as any).__harness = {
  calls,
  fired,
  mount(name: string, value: string, live: boolean, evil: boolean) {
    current = name
    hostile = !!evil
    batch(() => {
      setText(value)
      setStreaming(!!live)
      setNonce((n) => n + 1)
    })
  },
  update(value: string, live: boolean) {
    batch(() => {
      setText(value)
      setStreaming(!!live)
    })
  },
  measure() {
    const root = document.querySelector('[data-component="markdown"]')
    if (!root) return { present: false }
    const diagrams = Array.from(root.querySelectorAll('[data-slot="mermaid-diagram"]'))
    const svgs = Array.from(root.querySelectorAll('[data-slot="mermaid-diagram"] svg'))
    const rendered = Array.from(root.querySelectorAll('[data-mermaid-state="rendered"]'))
    const sources = Array.from(root.querySelectorAll('[data-component="markdown-code"]')).map((w) => ({
      language: w.querySelector("code")?.className ?? "",
      state: w.getAttribute("data-mermaid-state"),
      preDisplay: (() => {
        const pre = w.querySelector("pre")
        return pre ? getComputedStyle(pre).display : null
      })(),
    }))
    return {
      present: true,
      diagrams: diagrams.length,
      svgs: svgs.length,
      rendered: rendered.length,
      sources,
      labels: svgs
        .flatMap((svg) => Array.from(svg.querySelectorAll("text")))
        .map((t) => (t.textContent ?? "").trim())
        .filter(Boolean),
      // Whole subtree, so a payload surviving anywhere is visible — not just
      // inside the diagram slot.
      html: root.innerHTML,
      // Every URL that survived onto a link or a resource element, minus bare
      // same-document fragments: <use href="#icon"> is how session-ui's own copy
      // button draws its sprite, and a "#..." reference cannot address anything
      // offsite. Anything left is a URL the payload put there.
      hrefs: Array.from(root.querySelectorAll("a[href], a[*|href], image, use, iframe, object, embed"))
        .map((el) => el.getAttribute("href") ?? el.getAttribute("xlink:href") ?? "")
        .filter((href) => href && !href.startsWith("#")),
      childCount: root.childElementCount,
    }
  },
}
`

// ---- cases ------------------------------------------------------------------

const diagram = (a, b) => `flowchart TD\n  A[${a}] --> B[${b}]`

/**
 * The fence body a still-open fence projects into the code block — the same
 * slice `openCode` takes in markdown-stream.ts. Empty once the fence closes,
 * because then the block is complete and no longer a partial state.
 */
const fenceBody = (chunk) => {
  const newline = chunk.indexOf("\n")
  if (newline < 0) return ""
  const body = chunk.slice(newline + 1)
  return body.includes("```") || body.includes("~~~") ? "" : body
}

const CASES = [
  {
    name: "top-level-fence",
    why: "the bug: a bare ```mermaid fence is a mode:\"code\" block that never reached decorate()",
    diagrams: 1,
    labels: ["Top Alpha", "Top Beta"],
    sources: [diagram("Top Alpha", "Top Beta")],
    text: "```mermaid\n" + diagram("Top Alpha", "Top Beta") + "\n```\n",
  },
  {
    name: "fence-with-prose",
    why: "the fence is one block among several, so block indexing has to hold",
    diagrams: 1,
    labels: ["Prose Alpha", "Prose Beta"],
    sources: [diagram("Prose Alpha", "Prose Beta")],
    text:
      "Some words before the diagram.\n\n```mermaid\n" +
      diagram("Prose Alpha", "Prose Beta") +
      "\n```\n\nAnd some words after it.\n",
  },
  {
    name: "tilde-fence",
    why: "~~~ is a legal fence marker; the language detection must not be backtick-only",
    diagrams: 1,
    labels: ["Tilde Alpha", "Tilde Beta"],
    sources: [diagram("Tilde Alpha", "Tilde Beta")],
    text: "~~~mermaid\n" + diagram("Tilde Alpha", "Tilde Beta") + "\n~~~\n",
  },
  {
    name: "info-string-extras",
    why: "models emit ```mermaid title=x; only the first info-string word is the language",
    diagrams: 1,
    labels: ["Info Alpha", "Info Beta"],
    sources: [diagram("Info Alpha", "Info Beta")],
    text: "```mermaid title=x\n" + diagram("Info Alpha", "Info Beta") + "\n```\n",
  },
  {
    name: "nested-in-list-item",
    why: 'the second bug: nested fences take the mode:"full" marked+shiki path, which dropped language-mermaid',
    diagrams: 1,
    labels: ["List Alpha", "List Beta"],
    sources: [diagram("List Alpha", "List Beta")],
    text:
      "- A step with a diagram:\n\n  ```mermaid\n" +
      diagram("List Alpha", "List Beta")
        .split("\n")
        .map((line) => "  " + line)
        .join("\n") +
      "\n  ```\n",
  },
  {
    name: "nested-in-blockquote",
    why: 'same mode:"full" path, different container',
    diagrams: 1,
    labels: ["Quote Alpha", "Quote Beta"],
    sources: [diagram("Quote Alpha", "Quote Beta")],
    text:
      "> ```mermaid\n" +
      diagram("Quote Alpha", "Quote Beta")
        .split("\n")
        .map((line) => "> " + line)
        .join("\n") +
      "\n> ```\n",
  },
  {
    name: "streaming-then-settled",
    why: "the complete-gate: an ungated call renders a partial fence on every token",
    diagrams: 1,
    labels: ["Stream Alpha", "Stream Beta"],
    sources: [diagram("Stream Alpha", "Stream Beta")],
    // Cumulative prefixes, the way a real stream arrives, split mid-node-label.
    // The run waits for each one to actually land in the DOM before advancing
    // (see `landed` below), or an ungated renderer never gets the chance to fire
    // and the case silently stops testing the gate at all.
    //
    // The FIRST chunk must carry the whole info string. `project()` has an
    // incremental fast path that appends a streamed suffix to the open code
    // block without re-lexing, so the language it detected on the first chunk
    // sticks until the fence closes: opening with "```mer" pins the block to
    // `language-mer` for the entire stream, `renderMermaidBlocks` can never
    // match it, and every partial state below becomes unobservable. That is
    // correct app behaviour — the diagram still renders once the fence closes —
    // but it makes for a case that proves nothing.
    stream: [
      "```mermaid\n",
      "```mermaid\nflowchart TD\n",
      "```mermaid\nflowchart TD\n  A[Stream Al",
      "```mermaid\nflowchart TD\n  A[Stream Alpha] --> B[Stream",
      "```mermaid\nflowchart TD\n  A[Stream Alpha] --> B[Stream Beta]",
      "```mermaid\nflowchart TD\n  A[Stream Alpha] --> B[Stream Beta]\n```\n",
    ],
    // Of the intermediate bodies below, all but the last are unparseable
    // fragments; the last is the finished diagram inside a still-open fence.
    // Requiring most of them to be observed keeps a timing change from turning
    // this case into a no-op.
    minPartialStates: 3,
    text: "```mermaid\n" + diagram("Stream Alpha", "Stream Beta") + "\n```\n",
  },
  {
    name: "adversarial-hostile-svg",
    why: "the renderer's output is untrusted; a benign diagram must still land while the payload does not",
    diagrams: 1,
    hostile: true,
    labels: ["Hostile Alpha", "Hostile Beta"],
    sources: [diagram("Hostile Alpha", "Hostile Beta")],
    text: "```mermaid\n" + diagram("Hostile Alpha", "Hostile Beta") + "\n```\n",
  },
  {
    name: "negative/ts-fence",
    why: "a non-mermaid fence must never reach the renderer",
    diagrams: 0,
    sources: [],
    text: "```ts\nconst mermaid = 1\nflowchart TD\n```\n",
  },
  {
    name: "negative/inline-code",
    why: "inline `mermaid` is not a fence; matching on text would fire here",
    diagrams: 0,
    sources: [],
    text: "Ask the model for a `mermaid` diagram, e.g. `flowchart TD`.\n",
  },
]

const EXPECTED_DIAGRAMS = CASES.reduce((total, c) => total + c.diagrams, 0)
const EXPECTED_SOURCES = new Set(CASES.flatMap((c) => c.sources))

// ---- run --------------------------------------------------------------------

let server
let browser
let failed = 0
const fail = (message) => {
  failed++
  console.log("  FAIL " + message)
}

try {
  await rm(ROOT, { recursive: true, force: true })
  await mkdir(join(ROOT, "node_modules/@opencode-ai"), { recursive: true })
  // Resolve the package specifiers the way the app does, without a Vite alias:
  // node walks up from the fixture, finds these, and everything else
  // (@opencode-ai/ui, marked, shiki, solid-js, dompurify) resolves out of
  // packages/session-ui/node_modules one level further up.
  await symlink(PACKAGE, join(ROOT, "node_modules/@opencode-ai/session-ui"), "dir")
  await symlink(MERMAID_PACKAGE, join(ROOT, "node_modules/mermaid"), "dir")
  await writeFile(join(ROOT, "index.html"), INDEX_HTML)
  await writeFile(join(ROOT, "main.tsx"), MAIN_TSX)

  server = await createServer({
    configFile: false,
    root: ROOT,
    logLevel: "error",
    plugins: [solid()],
    // markdown-worker.ts imports `./markdown-shiki.worker.ts?worker&url`, and
    // the worker itself is ESM with imports — the default `iife` worker format
    // cannot express that.
    worker: { format: "es" },
    optimizeDeps: {
      // Pre-bundling these two rewrites the shiki/oniguruma wasm plumbing they
      // ship and the highlighter fails to start.
      exclude: ["@pierre/diffs", "@pierre/theming"],
    },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [REPO] } },
  })
  await server.listen()
  const url = server.resolvedUrls?.local?.[0]
  if (!url) throw new Error("vite did not report a local URL")

  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })

  const pageErrors = []
  const consoleErrors = []
  // The decisive check for the remote-fetch payloads (@import, <img>, <image>):
  // if any of them survived, the browser would try to load them.
  const offsiteRequests = []
  page.on("pageerror", (e) => pageErrors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text())
  })
  page.on("request", (r) => {
    if (r.url().includes("evil.example")) offsiteRequests.push(r.url())
  })

  await page.goto(url, { waitUntil: "load" })
  await page.waitForFunction(() => !!window.__harness, undefined, { timeout: 60_000 })

  // Warm Vite's dependency optimizer BEFORE the first real case. The first
  // diagram is what pulls mermaid, the shiki highlighter and the markdown worker
  // into the graph; Vite answers those newly-discovered deps with a 504 and a
  // full page reload, which silently wipes the mount out from under the case
  // that triggered it. Rendering one throwaway diagram forces the discovery, and
  // the reload afterwards starts the run on an already-optimized, stable graph
  // with a fresh (empty) call log.
  await page.evaluate(
    (text) => window.__harness.mount("warmup", text, false, false),
    "```mermaid\n" + diagram("Warm Up", "Optimizer") + "\n```\n",
  )
  // Tolerant on purpose: if the wiring is broken this never renders, and the run
  // must still reach the report and say WHICH fence shapes stopped working
  // rather than dying on a Playwright timeout. Dependency discovery — the thing
  // the warmup exists for — happens on module import, not on a successful
  // render, so it has already done its job either way.
  const warm = await page
    .waitForFunction(() => document.querySelectorAll('[data-mermaid-state="rendered"]').length === 1, undefined, {
      timeout: 90_000,
    })
    .then(() => true)
    .catch(() => false)
  if (!warm) console.log("  note warmup diagram never rendered; expect failures below")
  await page.reload({ waitUntil: "load" })
  await page.waitForFunction(() => !!window.__harness, undefined, { timeout: 60_000 })

  // Any reload from here on invalidates the call accounting, so make it loud
  // rather than letting it read as a missing diagram.
  let reloads = 0
  page.on("load", () => reloads++)

  const results = []
  for (const testCase of CASES) {
    const before = await page.evaluate(() => window.__harness.calls.length)
    let partialStates = 0

    await page.evaluate(
      ([name, text, hostile]) => window.__harness.mount(name, text, false, hostile),
      [testCase.name, testCase.stream ? testCase.stream[0] : testCase.text, !!testCase.hostile],
    )

    if (testCase.stream) {
      // Re-mount in streaming mode and feed cumulative prefixes, waiting for each
      // partial body to actually reach the DOM before sending the next one. The
      // wait is the point: `updateBlock` only runs when a projection lands, so
      // firing chunks on a fixed timer can skip every intermediate state and an
      // ungated renderer would never be caught.
      await page.evaluate(
        ([name, text, hostile]) => window.__harness.mount(name, text, true, hostile),
        [testCase.name, testCase.stream[0], !!testCase.hostile],
      )
      for (const chunk of testCase.stream.slice(1)) {
        await page.evaluate((text) => window.__harness.update(text, true), chunk)
        const partial = fenceBody(chunk)
        if (partial) {
          const landed = await page
            .waitForFunction(
              (want) =>
                Array.from(document.querySelectorAll('[data-component="markdown-code"] code')).some(
                  (code) => (code.textContent ?? "").trimEnd() === want,
                ),
              partial.trimEnd(),
              { timeout: 10_000 },
            )
            .then(() => true)
            .catch(() => false)
          if (landed) partialStates++
          if (DEBUG) {
            const shown = await page.evaluate(() =>
              Array.from(document.querySelectorAll('[data-component="markdown-code"] code')).map((code) => ({
                class: code.className,
                text: code.textContent,
              })),
            )
            console.log(`  debug want=${JSON.stringify(partial)} landed=${landed} dom=${JSON.stringify(shown)}`)
          }
        }
        await page.waitForTimeout(120)
      }
      await page.evaluate((text) => window.__harness.update(text, false), testCase.text)
    }

    if (testCase.diagrams > 0) {
      // Never throws: a case that does not render is a FAIL line in the report,
      // not a dead run. The budget is generous when the warmup proved rendering
      // works and short when it did not, so a broken build reports fast.
      await page
        .waitForFunction(
          (n) => document.querySelectorAll('[data-mermaid-state="rendered"]').length === n,
          testCase.diagrams,
          { timeout: warm ? 30_000 : 15_000 },
        )
        .catch(() => {})
    } else {
      await page.waitForFunction(() => {
        const root = document.querySelector('[data-component="markdown"]')
        return !!root && root.childElementCount > 0
      })
    }
    // Settle: catches a *second*, late diagram and gives an ungated streaming
    // renderer time to have produced one.
    await page.waitForTimeout(500)

    const measured = await page.evaluate(() => window.__harness.measure())
    const after = await page.evaluate(() => window.__harness.calls.length)
    results.push({ ...testCase, measured, calls: after - before, partialStates })
  }

  const finalCalls = await page.evaluate(() => window.__harness.calls)
  const fired = await page.evaluate(() => window.__fired)
  const hostileCase = results.find((r) => r.hostile)?.measured ?? {}
  const hostileHtml = hostileCase.html ?? ""
  const hostileHrefs = (hostileCase.hrefs ?? []).filter(Boolean)

  await browser.close()
  browser = undefined
  await server.close()
  server = undefined

  // ---- report ---------------------------------------------------------------

  console.log("\nFENCE SHAPES (each must reach the renderer and land a diagram)")
  for (const r of results) {
    const m = r.measured
    const tag = `  ${r.name.padEnd(26)}`
    const before = failed
    if (!m.present) {
      fail(`${r.name}: nothing rendered at all`)
      continue
    }
    if (r.diagrams === 0) {
      if (m.diagrams !== 0) fail(`${r.name}: rendered ${m.diagrams} diagram(s); expected none`)
      if (r.calls !== 0) fail(`${r.name}: renderer called ${r.calls}x; expected 0`)
      if (failed === before) console.log(`${tag} ok   no diagram, no renderer call`)
      continue
    }

    if (r.minPartialStates && r.partialStates < r.minPartialStates)
      fail(
        `${r.name}: only ${r.partialStates}/${r.minPartialStates} partial fence states reached the DOM, ` +
          `so the complete-gate was never actually exercised`,
      )
    if (m.svgs !== r.diagrams) fail(`${r.name}: ${m.svgs} '[data-slot="mermaid-diagram"] svg'; expected ${r.diagrams}`)
    if (m.diagrams !== r.diagrams) fail(`${r.name}: ${m.diagrams} diagram slot(s); expected ${r.diagrams}`)
    if (m.rendered !== r.diagrams) fail(`${r.name}: ${m.rendered} data-mermaid-state="rendered"; expected ${r.diagrams}`)
    if (r.calls !== r.diagrams) fail(`${r.name}: renderer called ${r.calls}x for ${r.diagrams} diagram(s)`)

    const mermaidSources = m.sources.filter((s) => /(?:^|\s)language-mermaid(?:\s|$)/.test(s.language))
    if (mermaidSources.length !== r.diagrams)
      fail(`${r.name}: ${mermaidSources.length} code block(s) carried language-mermaid; expected ${r.diagrams}`)
    for (const source of mermaidSources) {
      if (source.preDisplay !== "none")
        fail(`${r.name}: source <pre> is display:${source.preDisplay}; the raw fence is still visible`)
    }
    for (const label of r.labels) {
      if (!m.labels.includes(label)) fail(`${r.name}: node label "${label}" missing from the rendered svg`)
    }
    if (failed === before)
      console.log(
        `${tag} ok   svg=${m.svgs} calls=${r.calls}` +
          (r.minPartialStates ? ` partials=${r.partialStates}` : "") +
          ` labels=${JSON.stringify(m.labels)}`,
      )
  }

  console.log("\nRENDERER CALL ACCOUNTING")
  console.log(`  total calls=${finalCalls.length} expected=${EXPECTED_DIAGRAMS}`)
  if (reloads) fail(`the page reloaded ${reloads}x mid-run; every count below is unreliable`)
  if (finalCalls.length !== EXPECTED_DIAGRAMS)
    fail(`renderer called ${finalCalls.length}x for ${EXPECTED_DIAGRAMS} diagram(s)`)
  const partial = finalCalls.filter((c) => !EXPECTED_SOURCES.has(c.source))
  if (partial.length)
    fail(
      `renderer received ${partial.length} source(s) that are not a complete fence body: ` +
        JSON.stringify(partial.map((c) => `${c.case}: ${JSON.stringify(c.source)}`)),
    )
  else console.log("  ok   every call received a complete fence body")

  console.log("\nADVERSARIAL (hostile SVG from the renderer)")
  const leaked = ["<script", "onload=", "onerror=", "javascript:", "foreignobject", "HOSTILE_LEAK", "@import"].filter(
    (needle) => hostileHtml.toLowerCase().includes(needle.toLowerCase()),
  )
  if (leaked.length) fail(`payload survived into the DOM: ${JSON.stringify(leaked)}`)
  else console.log("  ok   no payload survived into the DOM")
  if (hostileHrefs.length) fail(`a link or resource URL survived: ${JSON.stringify(hostileHrefs)}`)
  else console.log("  ok   no link or resource URL survived")
  if (fired.length) fail(`payload executed: ${JSON.stringify(fired)}`)
  else console.log("  ok   nothing executed")
  if (offsiteRequests.length) fail(`payload phoned home: ${JSON.stringify(offsiteRequests)}`)
  else console.log("  ok   no offsite request attempted")

  if (pageErrors.length) console.log("\n  note page errors:", pageErrors.slice(0, 5))
  if (consoleErrors.length) console.log("  note console errors:", consoleErrors.slice(0, 5))

  console.log(failed === 0 ? "\nRESULT: PASS" : `\nRESULT: FAIL (${failed})`)
} finally {
  await browser?.close().catch(() => {})
  await server?.close().catch(() => {})
  await rm(ROOT, { recursive: true, force: true })
}

process.exit(failed === 0 ? 0 : 1)
