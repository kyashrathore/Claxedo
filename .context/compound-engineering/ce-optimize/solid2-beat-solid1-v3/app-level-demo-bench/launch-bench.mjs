import http from 'node:http'; import { readFile, stat } from 'node:fs/promises'; import path from 'node:path'; import { performance } from 'node:perf_hooks'; import { chromium } from '@playwright/test'
const ROOT=path.resolve(process.argv[2]||'dist-demo'); const LABEL=process.argv[3]||'candidate'; const REPS=Number(process.argv[4]||5)
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2','.wasm':'application/wasm','.map':'application/json','.ico':'image/x-icon','.png':'image/png'}
const srv=http.createServer(async(req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]);let fp=path.join(ROOT,p),s;try{if((await stat(fp)).isFile())s=fp}catch{};if(!s)s=path.join(ROOT,'demo','index.html');const body=await readFile(s);res.setHeader('content-type',mime[path.extname(s)]||'text/html');res.end(body)})
await new Promise(r=>srv.listen(0,'127.0.0.1',r)); const port=srv.address().port
const launches=[], heaps=[]
for(let i=0;i<REPS;i++){
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'})
  const p=await b.newPage(); await p.setViewportSize({width:1440,height:900})
  const cdp=await p.context().newCDPSession(p); await cdp.send('Performance.enable').catch(()=>{})
  const t0=performance.now()
  await p.goto(`http://127.0.0.1:${port}/demo/`,{waitUntil:'domcontentloaded'})
  await p.locator('[data-testid="workbench-root"]').first().waitFor({state:'visible',timeout:30000})
  // wait for composer input ready (first-fold interactive)
  await p.locator('[data-testid="session-page-root"], [data-testid="session-content"]').first().waitFor({state:'visible',timeout:30000}).catch(()=>{})
  const launchMs=performance.now()-t0
  await p.waitForTimeout(1500)
  const m=await cdp.send('Performance.getMetrics').catch(()=>({metrics:[]}))
  const heap=(m.metrics.find(x=>x.name==='JSHeapUsedSize')?.value||0)/1048576
  launches.push(launchMs); heaps.push(heap)
  await b.close()
}
const med=a=>{const s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length/2)]}
console.log('LAUNCHBENCH '+JSON.stringify({label:LABEL,reps:REPS,launch_median_ms:+med(launches).toFixed(1),launch_all:launches.map(x=>+x.toFixed(0)),heap_median_mib:+med(heaps).toFixed(2),heap_all:heaps.map(x=>+x.toFixed(1))}))
srv.close()
