// Take a heap snapshot after N switches and aggregate retained self_size by
// node class name to name the leaking constructor.
import http from "node:http"
import { readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { chromium } from "@playwright/test"

const ROOT = path.resolve(process.argv[2] || "packages/claxedo-app/dist-demo")
const SWITCHES = Number(process.argv[3] || 80)
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
const DIR = "/home/demo/projects/my-app"
const SES = ["ses_demo_001","ses_demo_002"]
const mime = {".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".svg":"image/svg+xml",".woff2":"font/woff2",".wasm":"application/wasm",".map":"application/json",".ico":"image/x-icon",".png":"image/png"}
const srv = http.createServer(async (req, res) => { let p=decodeURIComponent(req.url.split("?")[0]); let fp=path.join(ROOT,p),s; try{if((await stat(fp)).isFile())s=fp}catch{}; if(!s)s=path.join(ROOT,"demo","index.html"); const body=await readFile(s); res.setHeader("content-type",mime[path.extname(s)]||"text/html"); res.end(body) })
await new Promise((r)=>srv.listen(0,"127.0.0.1",r)); const port=srv.address().port
const b = await chromium.launch({ executablePath: CHROME }); const page = await b.newPage(); await page.setViewportSize({width:1440,height:900})
const cdp = await page.context().newCDPSession(page); await cdp.send("HeapProfiler.enable").catch(()=>{})
await page.goto(`http://127.0.0.1:${port}/demo/`, { waitUntil:"domcontentloaded" })
await page.locator('[data-testid="workbench-root"]').first().waitFor({ state:"visible", timeout:30000 }); await page.waitForTimeout(2500)
async function go(sid){ await page.evaluate(({DIR,sid})=>{ history.pushState({},"",`/demo/w/${encodeURIComponent(DIR)}/session/${sid}`); window.dispatchEvent(new PopStateEvent("popstate")) },{DIR,sid}); await page.locator(`[data-testid="session-page-root"][data-session-id="${sid}"]`).waitFor({state:"visible",timeout:10000}) }
for (let i=0;i<SWITCHES;i++){ await go(SES[i%2]) }
await cdp.send("HeapProfiler.collectGarbage").catch(()=>{})
let chunks = ""
cdp.on("HeapProfiler.addHeapSnapshotChunk", (e)=>{ chunks += e.chunk })
await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress:false, captureNumericValue:false })
await b.close(); srv.close()
const snap = JSON.parse(chunks)
const { node_fields, node_types } = snap.snapshot.meta
const typeIdx = node_fields.indexOf("type"), nameIdx = node_fields.indexOf("name"), sizeIdx = node_fields.indexOf("self_size")
const stride = node_fields.length
const typeNames = node_types[0] // array of type strings
const strings = snap.strings
const nodes = snap.nodes
const byName = new Map()  // "typeName:className" -> {count, bytes}
for (let i=0;i<nodes.length;i+=stride){
  const t = typeNames[nodes[i+typeIdx]]
  const nm = strings[nodes[i+nameIdx]] || ""
  const sz = nodes[i+sizeIdx]
  const key = `${t}:${nm}`.slice(0,60)
  const cur = byName.get(key) || {count:0,bytes:0}
  cur.count++; cur.bytes += sz
  byName.set(key, cur)
}
const top = [...byName.entries()].sort((a,b2)=>b2[1].bytes-a[1].bytes).slice(0,30)
const totalBytes = [...byName.values()].reduce((a,c)=>a+c.bytes,0)
console.log(`SNAPSHOT total ${(totalBytes/1048576).toFixed(1)} MiB across ${nodes.length/stride} nodes, after ${SWITCHES} switches`)
console.log("--- top retained by self_size (type:className  count  MiB) ---")
for (const [k,v] of top) console.log(`  ${(v.bytes/1048576).toFixed(2).padStart(7)} MiB  x${v.count.toString().padStart(7)}  ${k}`)
