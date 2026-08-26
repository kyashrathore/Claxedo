// Leak detector: switch sessions in rounds, force GC, measure RETAINED heap
// after GC each round. Monotonic growth after GC => disposal leak; plateau => retention.
import http from "node:http"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { chromium } from "@playwright/test"

const ROOT = path.resolve(process.argv[2] || "packages/claxedo-app/dist-demo")
const LABEL = process.argv[3] || "candidate"
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
const DIR = "/home/demo/projects/my-app"
const SES = ["ses_demo_001","ses_demo_002","ses_demo_003","ses_demo_004","ses_demo_005"]
const mime = {".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".svg":"image/svg+xml",".woff2":"font/woff2",".wasm":"application/wasm",".map":"application/json",".ico":"image/x-icon",".png":"image/png"}
const srv = http.createServer(async (req, res) => { let p=decodeURIComponent(req.url.split("?")[0]); let fp=path.join(ROOT,p),s; try{if((await stat(fp)).isFile())s=fp}catch{}; if(!s)s=path.join(ROOT,"demo","index.html"); const body=await readFile(s); res.setHeader("content-type",mime[path.extname(s)]||"text/html"); res.end(body) })
await new Promise((r)=>srv.listen(0,"127.0.0.1",r)); const port=srv.address().port
const b = await chromium.launch({ executablePath: CHROME }); const page = await b.newPage(); await page.setViewportSize({width:1440,height:900})
const cdp = await page.context().newCDPSession(page)
await page.goto(`http://127.0.0.1:${port}/demo/`, { waitUntil:"domcontentloaded" })
await page.locator('[data-testid="workbench-root"]').first().waitFor({ state:"visible", timeout:30000 }); await page.waitForTimeout(2500)
async function go(sid){ await page.evaluate(({DIR,sid})=>{ history.pushState({},"",`/demo/w/${encodeURIComponent(DIR)}/session/${sid}`); window.dispatchEvent(new PopStateEvent("popstate")) },{DIR,sid}); await page.locator(`[data-testid="session-page-root"][data-session-id="${sid}"]`).waitFor({state:"visible",timeout:10000}) }
async function retainedHeapMiB(){ await cdp.send("HeapProfiler.collectGarbage").catch(()=>{}); await cdp.send("HeapProfiler.collectGarbage").catch(()=>{}); await page.waitForTimeout(300); const m=await cdp.send("Performance.getMetrics").catch(()=>({metrics:[]})); return (m.metrics.find(x=>x.name==="JSHeapUsedSize")?.value||0)/1048576 }
await cdp.send("Performance.enable").catch(()=>{})
await cdp.send("HeapProfiler.enable").catch(()=>{})
// baseline
await go(SES[0]); await page.waitForTimeout(300)
const rows = []
rows.push(["baseline(after first open)", +(await retainedHeapMiB()).toFixed(1)])
for (let round=1; round<=6; round++){
  for (let i=0;i<20;i++){ await go(SES[(round*20+i)%SES.length]) }  // 20 switches
  rows.push([`after ${round*20} switches`, +(await retainedHeapMiB()).toFixed(1)])
}
console.log("LEAK "+LABEL)
for (const [k,v] of rows) console.log(`  ${v.toString().padStart(7)} MiB  (retained, post-GC)  ${k}`)
const growth = rows[rows.length-1][1] - rows[1][1]
console.log(`  GROWTH over 100 switches after GC: ${growth.toFixed(1)} MiB  -> ${growth>15?"LEAK SUSPECTED":"stable/retention"}`)
await b.close(); srv.close()
