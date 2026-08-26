// Profile PURE WARM switches between two already-open sessions, and attribute
// self-time by module (chunk) to tell app code from the Solid runtime.
import http from "node:http"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { chromium } from "@playwright/test"

const ROOT = path.resolve(process.argv[2] || "packages/claxedo-app/dist-demo")
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
const DIR = "/home/demo/projects/my-app"
const A = "ses_demo_001", B = "ses_demo_002"
const mime = {".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".svg":"image/svg+xml",".woff2":"font/woff2",".wasm":"application/wasm",".map":"application/json",".ico":"image/x-icon",".png":"image/png"}
const srv = http.createServer(async (req, res) => { let p=decodeURIComponent(req.url.split("?")[0]); let fp=path.join(ROOT,p),s; try{if((await stat(fp)).isFile())s=fp}catch{}; if(!s)s=path.join(ROOT,"demo","index.html"); const body=await readFile(s); res.setHeader("content-type",mime[path.extname(s)]||"text/html"); res.end(body) })
await new Promise((r)=>srv.listen(0,"127.0.0.1",r)); const port=srv.address().port
const b = await chromium.launch({ executablePath: CHROME }); const page = await b.newPage(); await page.setViewportSize({width:1440,height:900})
const cdp = await page.context().newCDPSession(page)
await page.goto(`http://127.0.0.1:${port}/demo/`, { waitUntil:"domcontentloaded" })
await page.locator('[data-testid="workbench-root"]').first().waitFor({ state:"visible", timeout:30000 }); await page.waitForTimeout(2500)
async function go(sid){ await page.evaluate(({DIR,sid})=>{ history.pushState({},"",`/demo/w/${encodeURIComponent(DIR)}/session/${sid}`); window.dispatchEvent(new PopStateEvent("popstate")) },{DIR,sid}); await page.locator(`[data-testid="session-page-root"][data-session-id="${sid}"]`).waitFor({state:"visible",timeout:10000}) }
await go(A); await go(B); await page.waitForTimeout(400)  // both open, warm
await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval",{interval:100}); await cdp.send("Profiler.start")
for (let i=0;i<60;i++){ await go(i%2?B:A) }
const { profile } = await cdp.send("Profiler.stop")
const byModule = new Map(), byFn = new Map()
for (const n of profile.nodes){ const cf=n.callFrame; const file=(cf.url||"").split("/").pop()||"(native)"; const mod=file.replace(/-[A-Za-z0-9_]{8}\.js$/,".js")||"(native)"; const h=n.hitCount||0; if(!h)continue; byModule.set(mod,(byModule.get(mod)||0)+h); byFn.set(`${cf.functionName||"(anon)"} @ ${mod}:${cf.lineNumber}`,(byFn.get(`${cf.functionName||"(anon)"} @ ${mod}:${cf.lineNumber}`)||0)+h) }
const total=[...byModule.values()].reduce((a,c)=>a+c,0)
console.log("WARM_TOTAL_SAMPLES "+total+" ~"+(total*0.1).toFixed(0)+"ms over 60 switches ("+((total*0.1)/60).toFixed(1)+"ms/switch cpu)")
console.log("--- by module ---")
for (const [k,v] of [...byModule.entries()].sort((a,b2)=>b2[1]-a[1]).slice(0,18)) console.log(`${((v/total)*100).toFixed(1).padStart(5)}%  ${k}`)
console.log("--- top functions ---")
for (const [k,v] of [...byFn.entries()].sort((a,b2)=>b2[1]-a[1]).slice(0,20)) console.log(`${((v/total)*100).toFixed(1).padStart(5)}%  ${k}`)
await b.close(); srv.close()
