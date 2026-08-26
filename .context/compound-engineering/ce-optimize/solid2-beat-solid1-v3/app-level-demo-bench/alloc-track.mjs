// Allocation-tracked heap snapshot: name the exact function+line allocating the
// leaked reactive scopes / detached DOM per switch.
import http from "node:http"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { chromium } from "@playwright/test"

const ROOT = path.resolve(process.argv[2] || "packages/claxedo-app/dist-demo")
const SWITCHES = Number(process.argv[3] || 40)
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
// warm both, THEN start allocation tracking so we only capture per-switch allocations
await go(SES[0]); await go(SES[1]); await page.waitForTimeout(300)
await cdp.send("HeapProfiler.startTrackingHeapObjects", { trackAllocations: true })
for (let i=0;i<SWITCHES;i++){ await go(SES[i%2]) }
await cdp.send("HeapProfiler.collectGarbage").catch(()=>{})
let chunks = ""; cdp.on("HeapProfiler.addHeapSnapshotChunk", (e)=>{ chunks += e.chunk })
await cdp.send("HeapProfiler.stopTrackingHeapObjects", { reportProgress:false })  // emits snapshot with allocation traces
await b.close(); srv.close()

const snap = JSON.parse(chunks)
const nf = snap.snapshot.meta.node_fields
const nodeTypes = snap.snapshot.meta.node_types[0]
const NS = nf.length
const nTypeI=nf.indexOf("type"), nNameI=nf.indexOf("name"), nTraceI=nf.indexOf("trace_node_id")
const nodes = snap.nodes, strings = snap.strings
const nodeCount = nodes.length / NS
// trace_function_infos: flat array of [function_id, name, script_name, script_id, line, column] * N
const tfi = snap.trace_function_infos || []
const TFI_STRIDE = 6
// trace_tree: nested [id, function_info_index, count, size, children[]]
const funcName = (fii)=>{ const b=fii*TFI_STRIDE; return `${strings[tfi[b+1]]||"?"} @ ${(strings[tfi[b+2]]||"").split("/").pop()}:${tfi[b+4]}:${tfi[b+5]}` }
// map trace_node_id -> function_info_index (walk the tree)
const tnToFii = new Map()
function walk(node){ // node = [id, fii, count, size, children]
  tnToFii.set(node[0], node[1])
  const kids = Array.isArray(node[4]) ? node[4] : []; for (const c of kids) walk(c)
}
if (Array.isArray(snap.trace_tree)) { if (Array.isArray(snap.trace_tree[0])) { for (const root of snap.trace_tree) walk(root) } else if (typeof snap.trace_tree[0]==="number") { /* flat: [id,fii,count,size,childCount,...] not handled */ console.log("(flat trace_tree, len "+snap.trace_tree.length+")") } }
// aggregate: for leaked nodes (Context/closure/detached SVG/HTML), attribute to allocation function
const leakName = (i)=>{ const n=`${nodeTypes[nodes[i*NS+nTypeI]]}:${strings[nodes[i*NS+nNameI]]||""}`; return n }
const byAlloc = new Map()
let attributed=0
for (let i=0;i<nodeCount;i++){
  const nm = leakName(i)
  if (!(nm==="object:system / Context" || nm.startsWith("closure:") || /SVGUseElement|SVGSVGElement|Detached|HTMLDivElement/.test(nm))) continue
  const tn = nodes[i*NS+nTraceI]
  if (!tn) continue
  const fii = tnToFii.get(tn); if (fii===undefined) continue
  const key = funcName(fii)
  byAlloc.set(key, (byAlloc.get(key)||0)+1); attributed++
}
console.log(`attributed ${attributed} leaked nodes to allocation sites (tracked ${SWITCHES} switches)`)
console.log("--- top allocation sites for leaked nodes (function @ script:line:col  count) ---")
for (const [k,v] of [...byAlloc.entries()].sort((a,b)=>b[1]-a[1]).slice(0,25)) console.log(`  ${String(v).padStart(7)}  ${k}`)
