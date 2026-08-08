import {
  detailMetricRows,
  formatDuration,
  formatInteger,
  formatPercent,
  headlineMetricRows,
  type ReportMetrics,
  type StoredReport,
} from "./report"

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!,
  )
}

const baseStyles = `
  :root { color-scheme: dark; --ink:#0b0d0a; --paper:#eff0e6; --acid:#d9ff43; --muted:#92988c; --line:#353a31; --hot:#ff7a3d; }
  * { box-sizing: border-box; }
  html { min-height: 100%; background: var(--ink); }
  body { margin: 0; min-height: 100vh; color: var(--paper); font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
    background: radial-gradient(circle at 84% 8%, rgba(217,255,67,.11), transparent 28rem),
      linear-gradient(rgba(255,255,255,.018) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.018) 1px, transparent 1px), var(--ink);
    background-size: auto, 32px 32px, 32px 32px, auto; }
  a { color: inherit; }
  .shell { width: min(960px, calc(100% - 32px)); margin: 0 auto; padding: 44px 0 64px; }
  .mast { display:flex; align-items:center; justify-content:space-between; gap:24px; margin-bottom:52px; }
  .brand { display:flex; align-items:center; gap:12px; text-transform:uppercase; letter-spacing:.12em; font-size:12px; font-weight:700; }
  .pulse { width:10px; height:10px; border-radius:50%; background:var(--acid); box-shadow:0 0 22px rgba(217,255,67,.75); }
  .stamp { color:var(--muted); text-transform:uppercase; letter-spacing:.12em; font-size:11px; }
  .eyebrow { color:var(--acid); text-transform:uppercase; letter-spacing:.16em; font-size:12px; font-weight:700; margin:0 0 20px; }
  h1 { max-width:780px; margin:0; font-family:Georgia, "Times New Roman", serif; font-size:clamp(52px, 9vw, 104px); line-height:.88; letter-spacing:-.065em; font-weight:400; }
  .lede { max-width:640px; color:#b7bcae; font-size:16px; line-height:1.7; margin:28px 0 40px; }
  .panel { position:relative; border:1px solid var(--line); background:rgba(15,18,14,.86); box-shadow:18px 18px 0 rgba(217,255,67,.07); }
  .panel::before { content:""; position:absolute; left:-1px; top:-1px; width:116px; height:3px; background:var(--acid); }
  .panel-head { display:flex; justify-content:space-between; gap:16px; padding:18px 22px; border-bottom:1px solid var(--line); color:var(--muted); text-transform:uppercase; letter-spacing:.11em; font-size:11px; }
  .command { padding:28px 22px; color:var(--acid); font-size:clamp(14px,3vw,21px); overflow:auto; }
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
  button, .button { appearance:none; border:1px solid var(--acid); background:var(--acid); color:#11140d; padding:14px 18px; font:700 13px/1 ui-monospace, monospace; text-decoration:none; text-transform:uppercase; letter-spacing:.08em; cursor:pointer; transition:transform .18s ease, box-shadow .18s ease; }
  button:hover, .button:hover { transform:translate(-3px,-3px); box-shadow:6px 6px 0 rgba(217,255,67,.22); }
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
  const headline = rows(headlineMetricRows(report))
  const detail = rows(detailMetricRows(report))
  return `<div class="panel"><div class="panel-head"><span>Runtime placement</span><span>Aggregate only</span></div><table><thead><tr><th>Metric</th><th>Result</th></tr></thead><tbody>${headline}</tbody></table><details class="metric-details"><summary>More detail <span>7 metrics</span></summary><table><tbody>${detail}</tbody></table></details></div>${placementDefinition()}`
}

function placementDefinition(): string {
  return `<p class="definition">A turn “completed without full machine” only when every observed execution call had a resolved lightweight runtime. The observed span starts at the first full-machine call and ends at the last timestamped execution call; it is not the complete turn duration. Lightweight calls can be powered by <a href="https://github.com/vercel-labs/just-bash" target="_blank" rel="noopener noreferrer">Vercel Labs’ just-bash ↗</a>.</p>`
}

function documentShell(title: string, body: string, nonce: string, head = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>${head}<style nonce="${nonce}">${baseStyles}</style></head><body>${body}</body></html>`
}

function mast(): string {
  return `<header class="mast"><div class="brand"><span class="pulse"></span><span>Agent Runtime Stats</span></div><div class="stamp">Local analysis / public aggregate</div></header>`
}

export function renderLandingPage(nonce: string): string {
  return documentShell(
    "Agent Runtime Stats",
    `<main class="shell"><div class="reveal">${mast()}<p class="eyebrow">Measure the execution boundary</p><h1>Does your agent need a machine for the whole turn?</h1><p class="lede">Analyze local coding-agent sessions and measure placement at the turn and session level. Raw transcripts, prompts, paths, and tool inputs stay on your machine.</p><div class="panel"><div class="panel-head"><span>Run locally</span><span>01 command</span></div><div class="command">npx @claxedo/agent-runtime-stats</div></div></div></main>`,
    nonce,
  )
}

const shareScript = `
  const errorBox = document.querySelector("#error");
  const button = document.querySelector("#publish");
  const integer = v => v.toLocaleString("en-US");
  const percent = v => v==null?"Unavailable":v.toFixed(2)+"%";
  const number = v => v==null?"Unavailable":v.toFixed(1).replace(/\\.0$/,"");
  const duration = v => v==null?"Unavailable":v<1000?Math.round(v)+"ms":(v/1000).toFixed(1)+"s";
  const headlineNames = [["sessionsAnalyzed","Sessions analyzed",integer],["executionCalls","Execution calls",integer],["sessionsWithoutFullMachinePercent","Sessions completed without full machine",percent]];
  const detailNames = [["turnsAnalyzed","Turns analyzed",integer],["turnCoveragePercent","Execution-call turn coverage",percent],["turnsWithoutFullMachinePercent","Turns completed without full machine",percent],["repeatFullMachineTurnPercent","Full-machine turns needing it again",percent],["medianCallsAfterFirstFullMachine","Median calls after first full-machine need",number],["medianObservedSpanAfterFirstFullMachineMs","Median observed span after first full-machine need",duration],["p95ObservedSpanAfterFirstFullMachineMs","p95 observed span after first full-machine need",duration]];
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
      const response = await fetch("/api/reports", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(report) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The report could not be published.");
      location.assign(result.url);
    } catch (error) { button.textContent = "Publish anonymous snapshot"; fail(error instanceof Error ? error.message : "The report could not be published."); }
  });
`

export function renderSharePage(nonce: string): string {
  return documentShell(
    "Review your anonymous runtime report",
    `<main class="shell"><div class="reveal">${mast()}<p class="eyebrow">Review before publishing</p><h1>Your data stays local until this click.</h1><p class="lede">Only the ten aggregate values below will be stored. No transcripts, prompts, repository names, file paths, or account identifiers are included.</p></div><div class="reveal two"><div class="panel"><div class="panel-head"><span>Runtime placement</span><span>Not uploaded</span></div><table><thead><tr><th>Metric</th><th>Result</th></tr></thead><tbody id="headline-metrics"></tbody></table><details class="metric-details"><summary>More detail <span>7 metrics</span></summary><table><tbody id="detail-metrics"></tbody></table></details></div>${placementDefinition()}</div><div class="reveal three actions"><button id="publish" disabled>Publish anonymous snapshot</button><a class="button secondary" href="/">Cancel</a></div><p class="privacy">Publishing creates an unlisted-but-public URL. Anyone with the URL can view and share it.</p><div id="error" class="error" role="alert"></div></main><script nonce="${nonce}">${shareScript}</script>`,
    nonce,
  )
}

export function renderReportPage(report: StoredReport, origin: string, nonce: string): string {
  const pageUrl = `${origin}/r/${report.id}`
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
      : ` Once a turn reaches one, ${formatPercent(report.repeatFullMachineTurnPercent)} need it again.`
  const postText = `${turnPlacement}${repeat}`
  const xUrl = `https://x.com/intent/post?text=${encodeURIComponent(postText)}&url=${encodeURIComponent(pageUrl)}`
  const head = `<meta name="description" content="Anonymous aggregate coding-agent runtime analysis"><meta property="og:type" content="website"><meta property="og:title" content="Agent Runtime Report"><meta property="og:description" content="${escapeHtml(postText)}"><meta property="og:url" content="${escapeHtml(pageUrl)}"><meta property="og:image" content="${escapeHtml(imageUrl)}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="Agent Runtime Report"><meta name="twitter:description" content="${escapeHtml(postText)}"><meta name="twitter:image" content="${escapeHtml(imageUrl)}">`
  const created = new Date(report.createdAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
  return documentShell(
    "Agent Runtime Report",
    `<main class="shell"><div class="reveal">${mast()}<p class="eyebrow">Anonymous snapshot / ${escapeHtml(created)}</p><h1>${formatInteger(report.executionCalls)} execution calls, mapped.</h1><p class="lede">A local analysis of coding-agent sessions, published as aggregate statistics. The source transcripts were never uploaded.</p></div><div class="reveal two">${table(report)}</div><div class="reveal three actions"><a class="button" href="${escapeHtml(xUrl)}" target="_blank" rel="noopener noreferrer">Share on X ↗</a><a class="button secondary" href="/">Run your own</a></div><p class="privacy">Public aggregate report ${escapeHtml(report.id.slice(0, 8))}. Raw session data is not part of this snapshot.</p></main>`,
    nonce,
    head,
  )
}

export function renderOgCard(report: ReportMetrics): string {
  const fullMachineTurnPercent =
    report.turnsWithoutFullMachinePercent === null ? null : 100 - report.turnsWithoutFullMachinePercent
  const split = [
    ["Turns need full machine", formatPercent(fullMachineTurnPercent)],
    ["VM turns need it again", formatPercent(report.repeatFullMachineTurnPercent)],
  ]
    .map(
      ([label, value]) =>
        `<div class="stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`,
    )
    .join("")
  const headline =
    fullMachineTurnPercent === null
      ? `<em>${formatInteger(report.executionCalls)}</em> execution calls, mapped.`
      : `<em>${formatPercent(fullMachineTurnPercent)}</em> of turns need a full machine.`
  return `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0;width:1200px;height:630px;overflow:hidden}body{padding:54px 62px;background:radial-gradient(circle at 88% 12%,#263015 0,transparent 30%),linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px),#0b0d0a;background-size:auto,34px 34px,34px 34px,auto;color:#eff0e6;font-family:ui-monospace,"SFMono-Regular",Consolas,monospace}.top{display:flex;justify-content:space-between;align-items:center;color:#9aa08f;font-size:18px;letter-spacing:.12em;text-transform:uppercase}.brand{color:#d9ff43;font-weight:700}.headline{margin:58px 0 38px;font-family:Georgia,"Times New Roman",serif;font-size:72px;line-height:.92;letter-spacing:-.05em;font-weight:400;max-width:980px}.headline em{color:#d9ff43;font-style:normal}.grid{display:grid;grid-template-columns:repeat(2,1fr);border:1px solid #3a4034}.stat{padding:22px 25px;border-right:1px solid #3a4034}.stat:last-child{border:0}.stat strong{display:block;color:#d9ff43;font-size:38px;line-height:1;margin-bottom:9px}.stat span{color:#aeb4a4;font-size:14px;text-transform:uppercase;letter-spacing:.08em}.foot{display:flex;justify-content:space-between;margin-top:22px;color:#8d9385;font-size:14px}.foot b{color:#eff0e6}</style></head><body><div class="top"><span class="brand">● Agent Runtime Stats</span><span>Anonymous aggregate</span></div><h1 class="headline">${headline}</h1><div class="grid">${split}</div><div class="foot"><span><b>${formatInteger(report.executionCalls)}</b> execution calls</span><span><b>${formatInteger(report.turnsAnalyzed)}</b> turns</span><span>turn coverage <b>${formatPercent(report.turnCoveragePercent)}</b></span><span>p95 observed span <b>${formatDuration(report.p95ObservedSpanAfterFirstFullMachineMs)}</b></span></div></body></html>`
}
