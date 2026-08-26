// Take a heap snapshot after N switches, then trace retainer paths upward from
// a sample of leaked detached DOM elements / contexts to name the leaking code.
import http from "node:http"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { chromium } from "@playwright/test"

const ROOT = path.resolve(process.argv[2] || "packages/claxedo-app/dist-demo")
const SWITCHES = Number(process.argv[3] || 60)
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
for (let i=0;i<SWITCHES;i++){ await go(SES[i%2]) }
await cdp.send("HeapProfiler.collectGarbage").catch(()=>{})
let chunks = ""; cdp.on("HeapProfiler.addHeapSnapshotChunk", (e)=>{ chunks += e.chunk })
await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress:false })
await b.close(); srv.close()

const snap = JSON.parse(chunks)
const nf = snap.snapshot.meta.node_fields, ef = snap.snapshot.meta.edge_fields
const nodeTypes = snap.snapshot.meta.node_types[0], edgeTypes = snap.snapshot.meta.edge_types[0]
const NS = nf.length, ES = ef.length
const nTypeI=nf.indexOf("type"), nNameI=nf.indexOf("name"), nEdgeI=nf.indexOf("edge_count"), nSizeI=nf.indexOf("self_size")
const eTypeI=ef.indexOf("type"), eNameI=ef.indexOf("name_or_index"), eToI=ef.indexOf("to_node")
const nodes = snap.nodes, edges = snap.edges, strings = snap.strings
const nodeCount = nodes.length / NS
// edge start offset per node (prefix sum of edge_count)
const edgeStart = new Uint32Array(nodeCount+1)
for (let i=0;i<nodeCount;i++) edgeStart[i+1] = edgeStart[i] + nodes[i*NS+nEdgeI]
// retainers: for each node, list of {from, edgeName}
const retFrom = new Array(nodeCount)
for (let i=0;i<nodeCount;i++){
  const base = edgeStart[i]*ES
  const cnt = nodes[i*NS+nEdgeI]
  for (let e=0;e<cnt;e++){
    const eb = base + e*ES
    const to = edges[eb+eToI] / NS
    const et = edgeTypes[edges[eb+eTypeI]]
    const en = (et==="element"||et==="hidden") ? `[${edges[eb+eNameI]}]` : (strings[edges[eb+eNameI]]||"?")
    ;(retFrom[to] ||= []).push({ from:i, edgeName:en, edgeType:et })
  }
}
const nodeName = (i)=>`${nodeTypes[nodes[i*NS+nTypeI]]}:${strings[nodes[i*NS+nNameI]]||""}`.slice(0,50)
// Samples: leaked Solid owner scopes. Trace up STRONG edges only.
const strongOK = (r)=> r.edgeType!=="weak" && !/synthetic|Traced handles/.test(nodeName(r.from))
const samples = []
for (let i=0;i<nodeCount && samples.length<4;i++){ const n=nodeName(i); if (/native:SVGUseElement/.test(n)) samples.push(i) }
for (let i=0;i<nodeCount && samples.length<8;i++){ if (nodeName(i)==="object:system / Context") samples.push(i) }
for (const s of samples){
  console.log("\n=== retainer path for "+nodeName(s)+" (node "+s+") ===")
  let cur = s; const seen = new Set([cur]); let depth=0
  while (depth++ < 25){
    const rs = (retFrom[cur]||[]).filter(strongOK).filter(r=>!seen.has(r.from))
    if (!rs.length){ console.log("  (root / no strong retainer)"); break }
    // prefer edges that carry a real property/context name and a named source
    const scored = rs.map(r=>{ const fn=strings[nodes[r.from*NS+nNameI]]||""; let sc=0
      if (/context/.test(r.edgeType)) sc+=3
      if (/property|internal/.test(r.edgeType)) sc+=2
      if (fn && !/^system/.test(fn)) sc+=2
      if (/Map|Set|Array|Store|Query|Observer|Owner|Root|Cache/.test(fn)) sc+=4
      return {r,sc} }).sort((a,b)=>b.sc-a.sc)
    const pick = scored[0].r
    const fn = strings[nodes[pick.from*NS+nNameI]]||""
    console.log(`  <-.${pick.edgeName} (${pick.edgeType})  from  ${nodeName(pick.from)}${fn&&!/^system/.test(fn)?"":""}`)
    seen.add(pick.from); cur = pick.from
    if (/Map|Set|:Array|Store|Query|Observer|Cache|:Window|global/.test(nodeName(pick.from)) && depth>3) { console.log("  (reached container)"); break }
  }
}
