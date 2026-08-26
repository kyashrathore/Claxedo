import http from 'node:http'; import { readFile, stat } from 'node:fs/promises'; import path from 'node:path'; import { performance } from 'node:perf_hooks'; import { chromium } from '@playwright/test'
const ROOT=path.resolve(process.argv[2]); const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2','.wasm':'application/wasm','.map':'application/json','.ico':'image/x-icon','.png':'image/png'}
const srv=http.createServer(async(req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]);let fp=path.join(ROOT,p),s;try{if((await stat(fp)).isFile())s=fp}catch{};if(!s)s=path.join(ROOT,'demo','index.html');const body=await readFile(s);res.setHeader('content-type',mime[path.extname(s)]||'text/html');res.end(body)})
await new Promise(r=>srv.listen(0,'127.0.0.1',r)); const port=srv.address().port
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'}); const page=await b.newPage(); await page.setViewportSize({width:1440,height:900})
const DIR='/home/demo/projects/my-app'; const SES=['ses_demo_001','ses_demo_002','ses_demo_003','ses_demo_004','ses_demo_005']
await page.goto(`http://127.0.0.1:${port}/demo/`,{waitUntil:'domcontentloaded'}); await page.locator('[data-testid="workbench-root"]').first().waitFor({state:'visible',timeout:30000}); await page.waitForTimeout(2500)
async function go(sid){ const t0=performance.now(); await page.evaluate(({DIR,sid})=>{history.pushState({},'',`/demo/w/${encodeURIComponent(DIR)}/session/${sid}`);window.dispatchEvent(new PopStateEvent('popstate'))},{DIR,sid}); await page.locator(`[data-testid="session-page-root"][data-session-id="${sid}"]`).waitFor({state:'visible',timeout:12000}); return performance.now()-t0 }
for(const s of SES){ try{await go(s)}catch{} } // open all
const marks=[1,5,10,20,30,50,80,110]; const d=[]
for(let i=0;i<120;i++){ const ms=await go(SES[i%SES.length]); d.push(ms); if(marks.includes(i+1)) console.log(`switch #${i+1}: ${ms.toFixed(0)}ms  (avg last5: ${(d.slice(-5).reduce((a,c)=>a+c,0)/Math.min(5,d.length)).toFixed(0)}ms)`) }
await b.close(); srv.close()
