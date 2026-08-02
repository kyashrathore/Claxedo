#!/usr/bin/env node
// RED e2e test for the virtua message-timeline LOAD bugs.
//
// These are real-browser timing/scroll bugs that happy-dom unit tests cannot
// catch (no real layout/scroll), so this drives the live app via the
// `browser-use` CLI + CDP.
//
// Requires:
//   - vite dev server at http://localhost:4444  (bun run dev)
//   - the `browser-use` daemon running (browser-use open ... once first)
//
// Bug 1 (blank-on-load): the session SOMETIMES lands blank — message viewport
//   stuck at scrollTop 0 with the rows rendered far below the fold (0 rows
//   visible). "Fixes when you scroll."
// Bug 2 (reload layout shift / flash): on reload, scrollTop spikes to 0 for a
//   frame (visible blank flash) before snapping to the bottom, while
//   scrollHeight reflows from the estimate to the measured height.
//
// Exit 0 only if BOTH behaviours are correct.
//
// Usage:  node packages/claxedo-app/scripts/timeline-load.e2e.mjs

import { execSync } from "node:child_process"
import { writeFileSync } from "node:fs"

const URL = process.env.TIMELINE_URL || "http://localhost:4444/s/ses_15cce07adffea4xiBFdu5k3rpX"
const RELOADS_A = Number(process.env.RELOADS_A || 30)
const RELOADS_B = Number(process.env.RELOADS_B || 3)

const run = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
const py = (stmt) => run(`browser-use python ${JSON.stringify(stmt)}`)
const sleep = (ms) => execSync(`sleep ${ms / 1000}`)
const evalJson = (js) => {
  const out = run(`browser-use eval ${JSON.stringify(js)}`)
  const m = out.match(/\{[\s\S]*\}/)
  return m ? JSON.parse(m[0]) : null
}

const MEASURE =
  "(()=>{const vp=[].slice.call(document.querySelectorAll('.scroll-view__viewport')).find(el=>el.querySelector('[data-message-id]'));" +
  "if(!vp)return JSON.stringify({overflow:false,on:0,st:0,dist:0});const r=vp.getBoundingClientRect();" +
  "const on=[].slice.call(vp.querySelectorAll('[data-message-id]')).filter(d=>{const b=d.getBoundingClientRect();return b.bottom>r.top+2&&b.top<r.bottom-2}).length;" +
  "return JSON.stringify({overflow:vp.scrollHeight-vp.clientHeight>4,st:Math.round(vp.scrollTop),dist:Math.round(vp.scrollHeight-vp.clientHeight-vp.scrollTop),on})})()"

// Per-frame recorder injected before document scripts (catches the sub-100ms flash).
const RECORDER =
  "(function(){var s=[];var t0=performance.now();function p(el){for(var n=el;n&&n.nodeType===1;n=n.parentElement){var cs=getComputedStyle(n);if(cs.display==='none'||cs.visibility==='hidden'||Number(cs.opacity)===0)return false}return true}" +
  "function f(){var vp=[].slice.call(document.querySelectorAll('.scroll-view__viewport')).find(function(el){return el.querySelector('[data-message-id]')});" +
  "if(vp){var r=vp.getBoundingClientRect();var rows=[].slice.call(vp.querySelectorAll('[data-message-id]'));var on=rows.filter(function(d){var b=d.getBoundingClientRect();return b.bottom>r.top+2&&b.top<r.bottom-2}).length;" +
  "var paintedOn=rows.filter(function(d){var b=d.getBoundingClientRect();return p(d)&&b.bottom>r.top+2&&b.top<r.bottom-2}).length;" +
  "s.push({t:Math.round(performance.now()-t0),sh:vp.scrollHeight,st:Math.round(vp.scrollTop),on:on,paintedOn:paintedOn})}" +
  "if(performance.now()-t0<3000)requestAnimationFrame(f)}window.__ts=s;requestAnimationFrame(f)})();"

const failures = []

console.log(`Target: ${URL}`)
py("cdp = browser._run(browser._session.get_or_create_cdp_session())")
py(
  "browser._run(cdp.cdp_client.send.Emulation.setDeviceMetricsOverride(params={'width':1512,'height':982,'deviceScaleFactor':1,'mobile':False}, session_id=cdp.session_id))",
)
py("browser._run(cdp.cdp_client.send.Page.enable(session_id=cdp.session_id))")

// ---- TEST A: never blank on load ----
console.log(`\nTEST A — no blank-on-load (${RELOADS_A} reloads)`)
const blanks = []
for (let i = 0; i < RELOADS_A; i++) {
  run(`browser-use open ${JSON.stringify(URL)}`)
  sleep(3000)
  const m = evalJson(MEASURE)
  const blank = !!(m && m.overflow && m.on === 0)
  if (blank) blanks.push({ i, ...m })
  process.stdout.write(blank ? "x" : ".")
}
process.stdout.write("\n")
if (blanks.length > 0)
  failures.push(`TEST A: ${blanks.length}/${RELOADS_A} reloads landed BLANK (viewport stuck at top, 0 rows visible). e.g. ${JSON.stringify(blanks[0])}`)
else console.log(`TEST A passed: 0/${RELOADS_A} blank`)

// ---- TEST B: no scrollTop flash / no post-paint reflow on reload ----
console.log(`\nTEST B — no flash/reflow on reload (${RELOADS_B} reloads, frame-resolution)`)
// Re-acquire the CDP session: TEST A's `browser-use open` calls may have moved
// the active target, leaving the setup-time `cdp` bound to a stale session.
py("cdp = browser._run(browser._session.get_or_create_cdp_session())")
py("browser._run(cdp.cdp_client.send.Page.enable(session_id=cdp.session_id))")
writeFileSync("/tmp/__timeline_rec.js", RECORDER)
let flashRuns = 0
let reflowRuns = 0
for (let i = 0; i < RELOADS_B; i++) {
  py("rec=open('/tmp/__timeline_rec.js').read()")
  py("browser._run(cdp.cdp_client.send.Page.addScriptToEvaluateOnNewDocument(params={'source':rec}, session_id=cdp.session_id))")
  py(`browser._run(cdp.cdp_client.send.Page.navigate(params={'url':${JSON.stringify(URL)}}, session_id=cdp.session_id))`)
  sleep(3500)
  const out = py(
    "r=browser._run(cdp.cdp_client.send.Runtime.evaluate(params={'expression':'JSON.stringify(window.__ts||[])','returnByValue':True}, session_id=cdp.session_id)); print('TS:'+r['result'].get('value',''))",
  )
  const line = out.split("\n").find((l) => l.startsWith("TS:"))
  const ts = line ? JSON.parse(line.slice(3)) : []
  const content = ts.filter((x) => (x.paintedOn ?? x.on) > 0)
  if (content.length === 0) {
    console.log(`  run ${i}: no content captured`)
    continue
  }
  const firstT = content[0].t
  const after = ts.filter((x) => x.t >= firstT)
  const stMax = Math.max(...after.map((x) => x.st))
  // flash: scrollTop dips to ~top AFTER content has appeared, while the settled
  // position is well below the top (so it should never have been at 0).
  const flashed = stMax > 100 && after.some((x) => x.st <= 2)
  // reflow: scrollHeight grows meaningfully after first content paint.
  const reflow = Math.max(...after.map((x) => x.sh)) - content[0].sh
  if (flashed) flashRuns++
  if (reflow > 40) reflowRuns++
  console.log(`  run ${i}: stSettled≈${stMax} flash(st→0 after paint)=${flashed} shReflow=${reflow}px`)
}
if (flashRuns > 0)
  failures.push(`TEST B: scrollTop flashed to the top after content paint in ${flashRuns}/${RELOADS_B} reloads (visible blank flash)`)
if (reflowRuns > 0)
  failures.push(`TEST B: scrollHeight reflowed (estimate→measured) after first paint in ${reflowRuns}/${RELOADS_B} reloads`)
if (flashRuns === 0 && reflowRuns === 0) console.log("TEST B passed")

console.log("")
if (failures.length) {
  console.error("RED — bugs reproduced:")
  for (const f of failures) console.error("  ✗ " + f)
  process.exit(1)
}
console.log("GREEN — both load behaviours are correct")
process.exit(0)
