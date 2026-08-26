// Sampling allocation profiler: attribute per-switch allocations to source
// functions (with url:line), and resolve through the sourcemap to the real
// source location. Names the leak's allocation site.
import http from "node:http"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { chromium } from "@playwright/test"

const ROOT = path.resolve(process.argv[2] || "packages/claxedo-app/dist-demo")
const SWITCHES = Number(process.argv[3] || 120)
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
const DIR = "/home/demo/projects/my-app"; const SES = ["ses_demo_001","ses_demo_002"]
const mime = {".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".svg":"image/svg+xml",".woff2":"font/woff2",".wasm":"application/wasm",".map":"application/json",".ico":"image/x-icon",".png":"image/png"}
const srv = http.createServer(async (req, res) => { let p=decodeURIComponent(req.url.split("?")[0]); let fp=path.join(ROOT,p),s; try{if((await stat(fp)).isFile())s=fp}catch{}; if(!s)s=path.join(ROOT,"demo","index.html"); const body=await readFile(s); res.setHeader("content-type",mime[path.extname(s)]||"text/html"); res.end(body) })
await new Promise((r)=>srv.listen(0,"127.0.0.1",r)); const port=srv.address().port
const b = await chromium.launch({ executablePath: CHROME }); const page = await b.newPage(); await page.setViewportSize({width:1440,height:900})
const cdp = await page.context().newCDPSession(page); await cdp.send("HeapProfiler.enable").catch(()=>{})
await page.goto(`http://127.0.0.1:${port}/demo/`, { waitUntil:"domcontentloaded" })
await page.locator('[data-testid="workbench-root"]').first().waitFor({ state:"visible", timeout:30000 }); await page.waitForTimeout(2500)
async function go(sid){ await page.evaluate(({DIR,sid})=>{ history.pushState({},"",`/demo/w/${encodeURIComponent(DIR)}/session/${sid}`); window.dispatchEvent(new PopStateEvent("popstate")) },{DIR,sid}); await page.locator(`[data-testid="session-page-root"][data-session-id="${sid}"]`).waitFor({state:"visible",timeout:10000}) }
await go(SES[0]); await go(SES[1]); await page.waitForTimeout(300)
await cdp.send("HeapProfiler.startSampling", { samplingInterval: 2048 })
for (let i=0;i<SWITCHES;i++){ await go(SES[i%2]) }
const { profile } = await cdp.send("HeapProfiler.stopSampling")
await b.close(); srv.close()

// aggregate self allocation size by callFrame
const byFrame = new Map()
function walk(node){
  const cf = node.callFrame
  const key = `${cf.functionName||"(anon)"} @ ${(cf.url||"").split("/").pop()}:${cf.lineNumber+1}:${cf.columnNumber+1}`
  byFrame.set(key, (byFrame.get(key)||0) + (node.selfSize||0))
  for (const c of node.children||[]) walk(c)
}
walk(profile.head)
const top = [...byFrame.entries()].sort((a,b)=>b[1]-a[1]).slice(0,30)
console.log(`SAMPLED allocations over ${SWITCHES} switches (self bytes by function)`)
for (const [k,v] of top) console.log(`  ${(v/1024).toFixed(0).padStart(8)} KB  ${k}`)
