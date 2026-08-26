// Real-browser app-level session-switch benchmark (URL-nav driver).
// Serves a built Claxedo demo bundle and switches sessions via client-side
// route navigation (pushState+popstate) — routing through the app's real
// route-bridge -> activateSession/showContent path (the code the refactor
// touches) — timing each switch to session-page-root visibility, plus JS heap
// via CDP. Identical synthetic demo data across arms. Not the frozen contract
// corpus, but a real app / real DOM / real reactive-graph measurement.
import http from "node:http"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { chromium } from "@playwright/test"

const ROOT = path.resolve(process.argv[2] || "packages/claxedo-app/dist-demo")
const LABEL = process.argv[3] || "candidate"
const SWITCHES = Number(process.argv[4] || 120)
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
// sessionId -> directory (from demo fixtures)
const MYAPP = "/home/demo/projects/my-app"
const FEAT = "/home/demo/projects/my-app-feature-auth"
const DASH = "/home/demo/projects/dashboard"
const SESSIONS = [
  ["ses_demo_001", MYAPP], ["ses_demo_002", MYAPP], ["ses_demo_003", MYAPP],
  ["ses_demo_004", MYAPP], ["ses_demo_005", MYAPP],
  ["ses_wt_001", FEAT], ["ses_wt_002", FEAT], ["ses_p2_001", DASH],
]
const mime = {".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".svg":"image/svg+xml",".woff2":"font/woff2",".wasm":"application/wasm",".map":"application/json",".ico":"image/x-icon",".png":"image/png"}

const srv = http.createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0])
  let fp = path.join(ROOT, p), served
  try { if ((await stat(fp)).isFile()) served = fp } catch {}
  if (!served) served = path.join(ROOT, "demo", "index.html")
  const body = await readFile(served)
  res.setHeader("content-type", mime[path.extname(served)] || "text/html")
  res.end(body)
})
await new Promise((r) => srv.listen(0, "127.0.0.1", r))
const port = srv.address().port

const b = await chromium.launch({ executablePath: CHROME })
const page = await b.newPage()
await page.setViewportSize({ width: 1440, height: 900 })
const cdp = await page.context().newCDPSession(page)
await cdp.send("Performance.enable").catch(() => {})
const heapMiB = async () => {
  const m = await cdp.send("Performance.getMetrics").catch(() => ({ metrics: [] }))
  return (m.metrics.find((x) => x.name === "JSHeapUsedSize")?.value ?? 0) / 1048576
}

await page.goto(`http://127.0.0.1:${port}/demo/`, { waitUntil: "domcontentloaded" })
await page.locator('[data-testid="workbench-root"]').first().waitFor({ state: "visible", timeout: 30000 })
await page.waitForTimeout(2500)
console.error(`[${LABEL}] workbench visible`)

// One switch: client-side nav to a session URL, wait for its page-root visible.
async function switchTo(sid, dir) {
  const t0 = performance.now()
  await page.evaluate(({ dir, sid }) => {
    const url = `/demo/w/${encodeURIComponent(dir)}/session/${sid}`
    history.pushState({}, "", url)
    window.dispatchEvent(new PopStateEvent("popstate"))
  }, { dir, sid })
  await page.locator(`[data-testid="session-page-root"][data-session-id="${sid}"]`).waitFor({ state: "visible", timeout: 10000 })
  return performance.now() - t0
}

// Warmup: open every session once (cold opens), so subsequent switches are warm.
for (const [sid, dir] of SESSIONS) { try { await switchTo(sid, dir) } catch (e) { console.error(`[${LABEL}] warmup ${sid} failed: ${String(e).slice(0,80)}`) } }
await page.waitForTimeout(500)
console.error(`[${LABEL}] warmup done`)

const durations = []
let prev = null
for (let i = 0; i < SWITCHES; i++) {
  const [sid, dir] = SESSIONS[i % SESSIONS.length]
  if (sid === prev) continue
  try { durations.push(await switchTo(sid, dir)); prev = sid } catch {}
}
await page.waitForTimeout(800)
const heap = await heapMiB()

if (durations.length === 0) { console.log(`SWITCH_FAIL ${LABEL}`); await b.close(); srv.close(); process.exit(1) }
durations.sort((a, b2) => a - b2)
const q = (f) => durations[Math.min(durations.length - 1, Math.floor(durations.length * f))]
const mean = durations.reduce((s, x) => s + x, 0) / durations.length
console.log("SWITCHURL " + JSON.stringify({
  label: LABEL, samples: durations.length,
  switch_median_ms: +q(0.5).toFixed(2), switch_mean_ms: +mean.toFixed(2),
  switch_p95_ms: +q(0.95).toFixed(2), switch_min_ms: +durations[0].toFixed(2),
  switch_max_ms: +durations[durations.length - 1].toFixed(2),
  switches_over_1000ms: durations.filter((d) => d > 1000).length,
  heap_used_mib: +heap.toFixed(2),
}))
await b.close(); srv.close()
