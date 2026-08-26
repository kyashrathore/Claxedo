// CPU-profile a batch of real session switches to locate the switch bottleneck.
import http from "node:http"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { chromium } from "@playwright/test"

const ROOT = path.resolve(process.argv[2] || "packages/claxedo-app/dist-demo")
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
const MYAPP = "/home/demo/projects/my-app", FEAT = "/home/demo/projects/my-app-feature-auth", DASH = "/home/demo/projects/dashboard"
const SESSIONS = [["ses_demo_001",MYAPP],["ses_demo_002",MYAPP],["ses_demo_003",MYAPP],["ses_demo_004",MYAPP],["ses_demo_005",MYAPP],["ses_wt_001",FEAT],["ses_wt_002",FEAT],["ses_p2_001",DASH]]
const mime = {".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".svg":"image/svg+xml",".woff2":"font/woff2",".wasm":"application/wasm",".map":"application/json",".ico":"image/x-icon",".png":"image/png"}
const srv = http.createServer(async (req, res) => { let p=decodeURIComponent(req.url.split("?")[0]); let fp=path.join(ROOT,p),s; try{if((await stat(fp)).isFile())s=fp}catch{}; if(!s)s=path.join(ROOT,"demo","index.html"); const body=await readFile(s); res.setHeader("content-type",mime[path.extname(s)]||"text/html"); res.end(body) })
await new Promise((r)=>srv.listen(0,"127.0.0.1",r)); const port=srv.address().port
const b = await chromium.launch({ executablePath: CHROME }); const page = await b.newPage(); await page.setViewportSize({width:1440,height:900})
const cdp = await page.context().newCDPSession(page)
await page.goto(`http://127.0.0.1:${port}/demo/`, { waitUntil:"domcontentloaded" })
await page.locator('[data-testid="workbench-root"]').first().waitFor({ state:"visible", timeout:30000 }); await page.waitForTimeout(2500)
async function switchTo(sid,dir){ await page.evaluate(({dir,sid})=>{ history.pushState({},"",`/demo/w/${encodeURIComponent(dir)}/session/${sid}`); window.dispatchEvent(new PopStateEvent("popstate")) },{dir,sid}); await page.locator(`[data-testid="session-page-root"][data-session-id="${sid}"]`).waitFor({state:"visible",timeout:10000}) }
for (const [sid,dir] of SESSIONS){ try{ await switchTo(sid,dir) }catch{} }  // warmup/open all
await page.waitForTimeout(400)
await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval",{interval:200}); await cdp.send("Profiler.start")
for (let i=0;i<40;i++){ const [sid,dir]=SESSIONS[i%SESSIONS.length]; try{ await switchTo(sid,dir) }catch{} }
const { profile } = await cdp.send("Profiler.stop")
// aggregate self-time by function
const nodesById = new Map(profile.nodes.map((n)=>[n.id,n]))
const selfHits = new Map()
for (const n of profile.nodes){ const cf=n.callFrame; const key=`${cf.functionName||"(anon)"} @ ${(cf.url||"").split("/").pop()}:${cf.lineNumber}`; selfHits.set(key,(selfHits.get(key)||0)+(n.hitCount||0)) }
const total = [...selfHits.values()].reduce((a,c)=>a+c,0)
const top = [...selfHits.entries()].sort((a,b2)=>b2[1]-a[1]).slice(0,30)
console.log("TOTAL_SAMPLES "+total+" interval_us=200 duration_ms~="+(total*0.2).toFixed(0))
for (const [k,v] of top){ console.log(`${((v/total)*100).toFixed(1).padStart(5)}%  ${v.toString().padStart(6)}  ${k}`) }
await b.close(); srv.close()
