import {
  formatDuration,
  formatInteger,
  formatPercent,
  metricRows,
  type ReportMetrics,
  type StoredReport,
} from "./report"
import { PUBLIC_ORIGIN, RESEARCH_PATH, REPORT_API_PATH, reportPath } from "../../src/share-contract.js"

const RESEARCH_URL = `${PUBLIC_ORIGIN}${RESEARCH_PATH}`

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!,
  )
}

const baseStyles = `
  :root { color-scheme: dark; --ink:#101010; --paper:#ededed; --acid:#fab283; --muted:#8f8f8f; --line:#3a3a3a; --hot:#f17471; }
  * { box-sizing: border-box; }
  html { min-height: 100%; background: var(--ink); }
  body { margin: 0; min-height: 100vh; color: var(--paper); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: radial-gradient(circle at 84% 8%, rgba(250,178,131,.11), transparent 28rem),
      linear-gradient(rgba(255,255,255,.018) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.018) 1px, transparent 1px), var(--ink);
    background-size: auto, 32px 32px, 32px 32px, auto; }
  a { color: inherit; }
  .shell { width: min(960px, calc(100% - 32px)); margin: 0 auto; padding: 44px 0 64px; }
  .mast { display:flex; align-items:center; justify-content:space-between; gap:24px; margin-bottom:52px; }
  .brand { display:flex; align-items:center; gap:12px; text-transform:uppercase; letter-spacing:.12em; font-size:12px; font-weight:700; }
  .pulse { width:10px; height:10px; border-radius:50%; background:var(--acid); box-shadow:0 0 22px rgba(250,178,131,.55); }
  .stamp { color:var(--muted); text-transform:uppercase; letter-spacing:.12em; font-size:11px; }
  .eyebrow { color:var(--acid); text-transform:uppercase; letter-spacing:.16em; font-size:12px; font-weight:700; margin:0 0 20px; }
  h1 { max-width:780px; margin:0; font-family:ui-sans-serif, system-ui, sans-serif; font-size:clamp(52px, 9vw, 104px); line-height:.88; letter-spacing:-.065em; font-weight:500; }
  .lede { max-width:640px; color:#b7bcae; font-size:16px; line-height:1.7; margin:28px 0 40px; }
  .panel { position:relative; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:rgba(22,22,22,.92); box-shadow:0 0 0 1px #282828, 0 12px 32px -8px rgba(0,0,0,.45); }
  .panel::before { content:""; position:absolute; left:-1px; top:-1px; width:116px; height:3px; background:var(--acid); }
  .panel-head { display:flex; justify-content:space-between; gap:16px; padding:18px 22px; border-bottom:1px solid var(--line); color:var(--muted); text-transform:uppercase; letter-spacing:.11em; font-size:11px; }
  .command { padding:28px 22px; color:var(--acid); font-family:ui-monospace, "SFMono-Regular", Consolas, monospace; font-size:clamp(14px,3vw,21px); overflow:auto; }
  table { width:100%; border-collapse:collapse; }
  th, td { padding:18px 22px; border-bottom:1px solid var(--line); text-align:left; }
  th { color:var(--muted); text-transform:uppercase; letter-spacing:.1em; font-size:10px; font-weight:600; }
  td { font-size:14px; }
  td:last-child, th:last-child { text-align:right; }
  td:last-child { color:var(--acid); font-size:18px; font-weight:700; font-variant-numeric:tabular-nums; }
  tr:last-child td { border-bottom:0; }
  .metric-details { border-top:1px solid var(--line); }
  .metric-details summary { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:17px 22px; color:var(--paper); cursor:pointer; text-transform:uppercase; letter-spacing:.1em; font-size:11px; font-weight:700; list-style:none; }
  .metric-details summary::-webkit-details-marker { display:none; }
  .metric-details summary::after { content:"+"; color:var(--acid); font-size:18px; line-height:1; }
  .metric-details[open] summary::after { content:"−"; }
  .metric-details summary span { color:var(--muted); font-weight:500; }
  .metric-details table { border-top:1px solid var(--line); }
  .actions { display:flex; flex-wrap:wrap; gap:12px; margin-top:28px; }
  .report-actions { margin-bottom:28px; }
  button, .button { appearance:none; border:1px solid var(--acid); border-radius:6px; background:var(--acid); color:#171311; padding:14px 18px; font:600 13px/1 ui-sans-serif, system-ui, sans-serif; text-decoration:none; cursor:pointer; transition:background .18s ease, border-color .18s ease; }
  button:hover, .button:hover { background:#ffc39d; border-color:#ffc39d; }
  button:disabled { cursor:not-allowed; opacity:.45; transform:none; box-shadow:none; }
  .button.secondary { background:transparent; color:var(--paper); border-color:var(--line); }
  .privacy { display:flex; gap:10px; align-items:flex-start; margin-top:20px; color:var(--muted); font-size:12px; line-height:1.5; }
  .privacy::before { content:"◈"; color:var(--acid); }
  .definition { margin:16px 2px 0; color:var(--muted); font-size:12px; line-height:1.6; }
  .definition a { color:var(--acid); text-underline-offset:3px; }
  .error { display:none; margin-top:18px; padding:14px 16px; color:#ffd8c6; border:1px solid #7d3c25; background:#2a1710; font-size:13px; line-height:1.5; }
  .error.visible { display:block; }
  .reveal { animation:reveal .7s cubic-bezier(.2,.8,.2,1) both; }
  .reveal.two { animation-delay:.09s; } .reveal.three { animation-delay:.18s; }
  @keyframes reveal { from { opacity:0; transform:translateY(18px); } to { opacity:1; transform:none; } }
  @media (max-width:640px) { .shell{padding-top:26px}.mast{margin-bottom:36px}h1{font-size:58px}.stamp{display:none}th,td{padding:15px 14px}.panel-head{padding:15px 14px} }
  @media (prefers-reduced-motion:reduce) { .reveal { animation:none; } button,.button { transition:none; } }
`

function rows(values: ReadonlyArray<readonly [string, string]>): string {
  return values
    .map(([metric, result]) => `<tr><td>${escapeHtml(metric)}</td><td>${escapeHtml(result)}</td></tr>`)
    .join("")
}

function table(report: ReportMetrics): string {
  return `<div class="panel"><div class="panel-head"><span>Runtime placement</span><span>13 aggregate metrics</span></div><table><thead><tr><th>Metric</th><th>Result</th></tr></thead><tbody>${rows(metricRows(report))}</tbody></table></div>${placementDefinition()}`
}

function placementDefinition(): string {
  return `<p class="definition">A turn “completed without full machine” only when every observed execution call had a resolved lightweight runtime. The observed span starts at the first full-machine call and ends at the last timestamped execution call; it is not the complete turn duration. Lightweight calls can be powered by <a href="https://github.com/vercel-labs/just-bash" target="_blank" rel="noopener noreferrer">Vercel Labs’ just-bash ↗</a>.</p>`
}

function documentShell(title: string, body: string, nonce: string, head = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>${head}<style nonce="${nonce}">${baseStyles}</style></head><body>${body}</body></html>`
}

function mast(): string {
  return `<header class="mast"><a class="brand" href="${PUBLIC_ORIGIN}"><span class="pulse"></span><span>Claxedo</span></a><div class="stamp">Coding agent machine demand</div></header>`
}

const shareScript = `
  const errorBox = document.querySelector("#error");
  const button = document.querySelector("#publish");
  const integer = v => v.toLocaleString("en-US");
  const percent = v => v==null?"Unavailable":v.toFixed(2)+"%";
  const number = v => v==null?"Unavailable":v.toFixed(1).replace(/\\.0$/,"");
  const duration = v => v==null?"Unavailable":v<1000?Math.round(v)+"ms":(v/1000).toFixed(1)+"s";
  const headlineNames = [["sessionsAnalyzed","Sessions analyzed",integer],["executionCalls","Execution calls",integer],["sessionsWithoutFullMachinePercent","Sessions completed without full machine",percent]];
  const detailNames = [["turnsAnalyzed","Turns analyzed",integer],["turnCoveragePercent","Execution-call turn coverage",percent],["turnsWithoutFullMachinePercent","Turns completed without full machine",percent],["repeatFullMachineTurnPercent","Full-machine turns needing it again",percent],["fullMachineReturnIntervalSamples","Measured full-machine return intervals",integer],["medianFullMachineReturnIntervalMs","Median interval before full machine needed again",duration],["p95FullMachineReturnIntervalMs","p95 interval before full machine needed again",duration],["medianCallsAfterFirstFullMachine","Median calls after first full-machine need",number],["medianObservedSpanAfterFirstFullMachineMs","Median observed span after first full-machine need",duration],["p95ObservedSpanAfterFirstFullMachineMs","p95 observed span after first full-machine need",duration]];
  let report;
  const fail = message => { errorBox.textContent = message; errorBox.classList.add("visible"); button.disabled = true; };
  try {
    const encoded = new URLSearchParams(location.hash.slice(1)).get("data");
    if (!encoded) throw new Error("No report was found in this link. Run the CLI again to create one.");
    const base64 = encoded.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(encoded.length/4)*4,"=");
    report = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0))));
    for (const [target,names] of [["headline-metrics",headlineNames],["detail-metrics",detailNames]]) {
      const body = document.querySelector("#"+target);
      for (const [key,label,format] of names) {
        const row = document.createElement("tr"), metric = document.createElement("td"), result = document.createElement("td");
        metric.textContent = label; result.textContent = format(report[key]); row.append(metric,result); body.append(row);
      }
    }
    button.disabled = false;
  } catch (error) { fail(error instanceof Error ? error.message : "This share link is invalid."); }
  button.addEventListener("click", async () => {
    button.disabled = true; button.textContent = "Publishing…"; errorBox.classList.remove("visible");
    try {
      const response = await fetch(${JSON.stringify(REPORT_API_PATH)}, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(report) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The report could not be published.");
      location.assign(result.url);
    } catch (error) { button.textContent = "Publish anonymous snapshot"; fail(error instanceof Error ? error.message : "The report could not be published."); }
  });
`

export function renderSharePage(nonce: string): string {
  return documentShell(
    "Review your anonymous runtime report",
    `<main class="shell"><div class="reveal">${mast()}<p class="eyebrow">Review before publishing</p><h1>Your data stays local until this click.</h1><p class="lede">Only the thirteen aggregate values below will be stored. No transcripts, prompts, repository names, file paths, or account identifiers are included.</p></div><div class="reveal two"><div class="panel"><div class="panel-head"><span>Runtime placement</span><span>Not uploaded</span></div><table><thead><tr><th>Metric</th><th>Result</th></tr></thead><tbody id="headline-metrics"></tbody></table><details class="metric-details"><summary>More detail <span>10 metrics</span></summary><table><tbody id="detail-metrics"></tbody></table></details></div>${placementDefinition()}</div><div class="reveal three actions"><button id="publish" disabled>Publish anonymous snapshot</button><a class="button secondary" href="${RESEARCH_URL}">Cancel</a></div><p class="privacy">Publishing creates an unlisted-but-public URL. Anyone with the URL can view and share it.</p><div id="error" class="error" role="alert"></div></main><script nonce="${nonce}">${shareScript}</script>`,
    nonce,
    '<meta name="robots" content="noindex, follow">',
  )
}

export function renderReportPage(report: StoredReport, origin: string, nonce: string): string {
  const pageUrl = `${origin}${reportPath(report.id)}`
  const imageUrl = `${pageUrl}/og.png`
  const fullMachineTurnPercent =
    report.turnsWithoutFullMachinePercent === null ? null : 100 - report.turnsWithoutFullMachinePercent
  const turnPlacement =
    fullMachineTurnPercent === null
      ? "My agent’s turn-level full-machine rate was unavailable."
      : `My agent needs a full machine in ${formatPercent(fullMachineTurnPercent)} of analyzed turns.`
  const repeat =
    report.repeatFullMachineTurnPercent === null
      ? ""
      : ` Of the turns that need one, ${formatPercent(report.repeatFullMachineTurnPercent)} call it again.`
  const hasReturnIntervals = report.medianFullMachineReturnIntervalMs !== null
  const postText = hasReturnIntervals
    ? `My coding agent needs a full machine again every ${formatDuration(report.medianFullMachineReturnIntervalMs)} (median). 95% of measured returns happen within ${formatDuration(report.p95FullMachineReturnIntervalMs)}.`
    : `${turnPlacement}${repeat}`
  const xUrl = `https://x.com/intent/post?text=${encodeURIComponent(postText)}&url=${encodeURIComponent(pageUrl)}`
  const title = "Coding Agent Machine Demand"
  const head = `<meta name="robots" content="noindex, follow"><link rel="canonical" href="${escapeHtml(pageUrl)}"><meta name="description" content="Anonymous aggregate coding-agent machine-demand analysis"><meta property="og:type" content="website"><meta property="og:title" content="${title}"><meta property="og:description" content="${escapeHtml(postText)}"><meta property="og:url" content="${escapeHtml(pageUrl)}"><meta property="og:image" content="${escapeHtml(imageUrl)}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${escapeHtml(postText)}"><meta name="twitter:image" content="${escapeHtml(imageUrl)}">`
  const created = new Date(report.createdAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
  const headline = hasReturnIntervals
    ? `Full machine needed again every ${formatDuration(report.medianFullMachineReturnIntervalMs)}.`
    : `${formatInteger(report.executionCalls)} execution calls, mapped.`
  const lede = hasReturnIntervals
    ? `The median measured interval before this agent needed a full machine again was ${formatDuration(report.medianFullMachineReturnIntervalMs)}. 95% of measured returns happened within ${formatDuration(report.p95FullMachineReturnIntervalMs)}.`
    : "This older snapshot did not capture full-machine return intervals. Its available aggregate runtime statistics are shown below."
  const reportScript = `
    const checkYours = document.querySelector("#check-yours");
    checkYours.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText("npx @claxedo/agent-runtime-stats");
        checkYours.textContent = "Command copied";
      } catch { checkYours.textContent = "Copy failed"; }
    });
  `
  return documentShell(
    title,
    `<main class="shell"><div class="reveal">${mast()}<p class="eyebrow">Anonymous snapshot / ${escapeHtml(created)}</p><h1>${escapeHtml(headline)}</h1><p class="lede">${escapeHtml(lede)} The source transcripts were never uploaded.</p></div><div class="reveal two actions report-actions"><a class="button" href="${escapeHtml(xUrl)}" target="_blank" rel="noopener noreferrer">Share on X ↗</a><button class="button secondary" id="check-yours" type="button" aria-live="polite">Check yours</button></div><div class="reveal three">${table(report)}</div><p class="privacy">Public aggregate report ${escapeHtml(report.id.slice(0, 8))}. Raw session data is not part of this snapshot.</p></main><script nonce="${nonce}">${reportScript}</script>`,
    nonce,
    head,
  )
}

export function renderOgCard(report: ReportMetrics): string {
  const fullMachineTurnPercent =
    report.turnsWithoutFullMachinePercent === null ? null : 100 - report.turnsWithoutFullMachinePercent
  const hasReturnIntervals = report.medianFullMachineReturnIntervalMs !== null
  const split = (
    hasReturnIntervals
      ? [
          ["p95 return interval", formatDuration(report.p95FullMachineReturnIntervalMs)],
          ["Measured intervals", formatInteger(report.fullMachineReturnIntervalSamples)],
        ]
      : [
          ["Turns needing a full machine", formatPercent(fullMachineTurnPercent)],
          ["Of those, calls it again", formatPercent(report.repeatFullMachineTurnPercent)],
        ]
  )
    .map(
      ([label, value]) =>
        `<div class="stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`,
    )
    .join("")
  const headline = hasReturnIntervals
    ? `Every <em>${formatDuration(report.medianFullMachineReturnIntervalMs)}</em>`
    : fullMachineTurnPercent === null
      ? `<em>${formatInteger(report.executionCalls)}</em> execution calls, mapped.`
      : `<em>${formatPercent(fullMachineTurnPercent)}</em> of turns need a full machine.`
  const subtitle = hasReturnIntervals
    ? "Median interval before this agent needed a full machine again"
    : "Anonymous aggregate runtime analysis"
  return `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0;width:1200px;height:630px;overflow:hidden}body{position:relative;padding:50px 62px;background:radial-gradient(circle at 88% 12%,#36241d 0,transparent 30%),linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px),#101010;background-size:auto,34px 34px,34px 34px,auto;color:#ededed;font-family:ui-monospace,"SFMono-Regular",Consolas,monospace}.top{display:flex;justify-content:space-between;align-items:center;color:#8f8f8f;font-size:16px;letter-spacing:.12em;text-transform:uppercase}.brand{color:#fab283;font-weight:700}.headline{margin:58px 0 12px;font-family:Arial,sans-serif;font-size:104px;line-height:.92;letter-spacing:-.06em;font-weight:500;max-width:1000px}.headline em{color:#fab283;font-style:normal}.subtitle{margin:0 0 52px;color:#aaa;font-size:18px}.grid{display:grid;grid-template-columns:repeat(2,1fr);min-height:126px;border:1px solid #3a3a3a;border-radius:8px;overflow:hidden}.stat{display:flex;flex-direction:column;justify-content:center;padding:20px 25px;border-right:1px solid #3a3a3a}.stat:last-child{border:0}.stat strong{display:block;color:#fab283;font-size:34px;line-height:1;margin-bottom:9px}.stat span{color:#a0a0a0;font-size:13px;text-transform:uppercase;letter-spacing:.08em}.foot{position:absolute;left:62px;right:62px;bottom:50px;display:flex;justify-content:space-between;color:#8f8f8f;font-size:13px}.foot b{color:#ededed}</style></head><body><div class="top"><span class="brand">● Claxedo</span><span>Coding agent machine demand</span></div><h1 class="headline">${headline}</h1><p class="subtitle">${subtitle}</p><div class="grid">${split}</div><div class="foot"><span><b>${formatInteger(report.executionCalls)}</b> execution calls</span><span><b>${formatInteger(report.turnsAnalyzed)}</b> turns</span><span>turn coverage <b>${formatPercent(report.turnCoveragePercent)}</b></span><span>claxedo.com</span></div></body></html>`
}
