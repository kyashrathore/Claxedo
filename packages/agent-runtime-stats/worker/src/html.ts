import {
  formatDuration,
  formatInteger,
  formatNumber,
  formatPercent,
  type ReportMetrics,
  type StoredReport,
} from "./report"
import { PUBLIC_ORIGIN, REPORT_API_PATH, reportPath } from "../../src/share-contract.js"

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
  .section-head { display:flex; justify-content:space-between; gap:16px; margin-bottom:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.11em; font-size:11px; }
  .finding-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; margin-bottom:32px; }
  .finding { position:relative; min-height:190px; display:flex; flex-direction:column; justify-content:space-between; padding:24px; overflow:hidden; border:1px solid var(--line); border-radius:8px; background:rgba(22,22,22,.92); box-shadow:0 12px 32px -12px rgba(0,0,0,.5); }
  .finding:first-child { grid-column:1/-1; min-height:164px; background:linear-gradient(105deg,rgba(250,178,131,.1),rgba(22,22,22,.94) 44%); }
  .finding::before { content:""; position:absolute; left:-1px; top:-1px; width:84px; height:3px; background:var(--acid); }
  .finding strong { color:var(--acid); font-size:clamp(42px,7vw,68px); line-height:.92; letter-spacing:-.055em; font-weight:600; font-variant-numeric:tabular-nums; }
  .finding-copy { margin-top:28px; }
  .finding span { display:block; color:var(--paper); font-size:14px; font-weight:650; }
  .finding p { margin:7px 0 0; color:var(--muted); font-size:12px; line-height:1.45; }
  .details-panel { overflow:hidden; border:1px solid var(--line); border-radius:8px; background:rgba(22,22,22,.84); box-shadow:0 0 0 1px #282828; }
  .details-panel .section-head { margin:0; padding:17px 20px; border-bottom:1px solid var(--line); }
  .detail-list { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); margin:0; }
  .detail-row { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:20px; padding:16px 20px; border-bottom:1px solid var(--line); }
  .detail-row:nth-child(odd) { border-right:1px solid var(--line); }
  .detail-row:nth-last-child(-n+2) { border-bottom:0; }
  .detail-row:last-child:nth-child(odd) { grid-column:1/-1; border-right:0; }
  .detail-row dt { color:#b6b6b6; font-size:12px; line-height:1.35; }
  .detail-row dd { flex:0 0 auto; margin:0; color:var(--acid); font-size:16px; font-weight:700; font-variant-numeric:tabular-nums; }
  .actions { display:flex; flex-wrap:wrap; gap:12px; margin-top:28px; }
  .report-actions { display:grid; grid-template-columns:auto minmax(0,1fr); gap:12px; margin:0 0 28px; }
  .report-actions > .button { display:flex; align-items:center; justify-content:center; }
  .measure-cta { min-width:0; display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:14px; padding:8px 8px 8px 16px; border:1px solid var(--line); border-radius:6px; background:rgba(22,22,22,.72); }
  .measure-cta span { color:var(--muted); text-transform:uppercase; letter-spacing:.11em; font-size:10px; font-weight:700; white-space:nowrap; }
  .measure-cta code { min-width:0; overflow:hidden; color:var(--paper); font:12px/1.3 ui-monospace, "SFMono-Regular", Consolas, monospace; text-overflow:ellipsis; white-space:nowrap; }
  .measure-cta button { border-color:var(--line); background:transparent; color:var(--paper); padding:11px 14px; }
  .measure-cta button:hover { border-color:var(--acid); background:transparent; color:var(--acid); }
  button, .button { appearance:none; border:1px solid var(--acid); border-radius:6px; background:var(--acid); color:#171311; padding:14px 18px; font:600 13px/1 ui-sans-serif, system-ui, sans-serif; text-decoration:none; cursor:pointer; transition:background .18s ease, border-color .18s ease; }
  button:hover, .button:hover { background:#ffc39d; border-color:#ffc39d; }
  button:disabled { cursor:not-allowed; opacity:.45; transform:none; box-shadow:none; }
  .button.secondary { background:transparent; color:var(--paper); border-color:var(--line); }
  .definition { margin:16px 2px 0; color:var(--muted); font-size:12px; line-height:1.6; }
  .definition a { color:var(--acid); text-underline-offset:3px; }
  .error { display:none; margin-top:18px; padding:14px 16px; color:#ffd8c6; border:1px solid #7d3c25; background:#2a1710; font-size:13px; line-height:1.5; }
  .error.visible { display:block; }
  .reveal { animation:reveal .7s cubic-bezier(.2,.8,.2,1) both; }
  .reveal.two { animation-delay:.09s; } .reveal.three { animation-delay:.18s; }
  @keyframes reveal { from { opacity:0; transform:translateY(18px); } to { opacity:1; transform:none; } }
  @media (max-width:640px) { .shell{padding-top:26px}.mast{margin-bottom:36px}h1{font-size:58px}.stamp{display:none}.report-actions{grid-template-columns:1fr}.measure-cta{grid-template-columns:1fr auto}.measure-cta span{grid-column:1/-1}.measure-cta code{font-size:11px}.finding-grid,.detail-list{grid-template-columns:1fr}.finding{min-height:164px}.detail-row,.detail-row:nth-child(odd){border-right:0;border-bottom:1px solid var(--line)}.detail-row:nth-last-child(2){border-bottom:1px solid var(--line)} }
  @media (prefers-reduced-motion:reduce) { .reveal { animation:none; } button,.button { transition:none; } }
`

function findingCards(values: ReadonlyArray<readonly [string, string, string]>): string {
  return values
    .map(
      ([label, value, context]) =>
        `<article class="finding"><strong>${escapeHtml(value)}</strong><div class="finding-copy"><span>${escapeHtml(label)}</span><p>${escapeHtml(context)}</p></div></article>`,
    )
    .join("")
}

function detailRows(values: ReadonlyArray<readonly [string, string]>): string {
  return values
    .map(([label, value]) => `<div class="detail-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("")
}

function reportMetrics(report: ReportMetrics): string {
  const findings: ReadonlyArray<readonly [string, string, string]> = [
    ["Sessions analyzed", formatInteger(report.sessionsAnalyzed), `Across ${formatInteger(report.executionCalls)} execution calls`],
    ["Median return interval", formatDuration(report.medianFullMachineReturnIntervalMs), "Before a full machine was needed again"],
    ["p95 return interval", formatDuration(report.p95FullMachineReturnIntervalMs), "95% of measured returns happened within this time"],
    ["Machine-requiring turns that returned", formatPercent(report.repeatFullMachineTurnPercent), "These turns needed the full machine more than once"],
    ["Turns completed without full machine", formatPercent(report.turnsWithoutFullMachinePercent), "Every observed execution call stayed lightweight"],
  ]
  const details: ReadonlyArray<readonly [string, string]> = [
    ["Sessions completed without full machine", formatPercent(report.sessionsWithoutFullMachinePercent)],
    ["Turns analyzed", formatInteger(report.turnsAnalyzed)],
    ["Execution-call turn coverage", formatPercent(report.turnCoveragePercent)],
    ["Measured full-machine return intervals", formatInteger(report.fullMachineReturnIntervalSamples)],
    ["Median calls after first full-machine need", formatNumber(report.medianCallsAfterFirstFullMachine)],
    ["Median observed span after first full-machine need", formatDuration(report.medianObservedSpanAfterFirstFullMachineMs)],
    ["p95 observed span after first full-machine need", formatDuration(report.p95ObservedSpanAfterFirstFullMachineMs)],
  ]
  return `<section aria-labelledby="findings-title"><div class="section-head"><span id="findings-title">Main findings</span><span>At a glance</span></div><div class="finding-grid">${findingCards(findings)}</div></section><section class="details-panel" aria-labelledby="details-title"><div class="section-head"><span id="details-title">Report details</span><span>7 metrics</span></div><dl class="detail-list">${detailRows(details)}</dl></section>${placementDefinition()}`
}

function placementDefinition(): string {
  return `<p class="definition">A turn “completed without full machine” only when every observed execution call had a resolved lightweight runtime. The observed span starts at the first full-machine call and ends at the last timestamped execution call; it is not the complete turn duration. Lightweight calls can be powered by <a href="https://github.com/vercel-labs/just-bash" target="_blank" rel="noopener noreferrer">Vercel Labs’ just-bash ↗</a>.</p>`
}

function measureCommand(): string {
  return `<div class="measure-cta"><span>Measure your own</span><code>npx @claxedo/agent-runtime-stats</code><button class="copy-command" type="button" aria-live="polite">Copy</button></div>`
}

const copyCommandScript = `
  for (const copyCommand of document.querySelectorAll(".copy-command")) {
    copyCommand.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText("npx @claxedo/agent-runtime-stats");
        copyCommand.textContent = "Copied";
        setTimeout(() => { copyCommand.textContent = "Copy"; }, 1600);
      } catch { copyCommand.textContent = "Copy failed"; }
    });
  }
`

function documentShell(title: string, body: string, nonce: string, head = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>${head}<style nonce="${nonce}">${baseStyles}</style></head><body>${body}</body></html>`
}

function mast(): string {
  return `<header class="mast"><a class="brand" href="${PUBLIC_ORIGIN}"><span class="pulse"></span><span>Claxedo</span></a><div class="stamp">Coding agent machine demand</div></header>`
}

const shareScript = `
  ${copyCommandScript}
  const errorBox = document.querySelector("#error");
  const button = document.querySelector("#save-share");
  const headline = document.querySelector("#report-headline");
  const lede = document.querySelector("#report-lede");
  const findings = document.querySelector("#report-findings");
  const details = document.querySelector("#report-details");
  const integer = v => v.toLocaleString("en-US");
  const percent = v => v==null?"Unavailable":v.toFixed(2)+"%";
  const number = v => v==null?"Unavailable":v.toFixed(1).replace(/\\.0$/,"");
  const duration = v => v==null?"Unavailable":v<1000?Math.round(v)+"ms":(v/1000).toFixed(1)+"s";
  const findingNames = [["sessionsAnalyzed","Sessions analyzed",integer,()=>"Across "+integer(report.executionCalls)+" execution calls"],["medianFullMachineReturnIntervalMs","Median return interval",duration,()=>"Before a full machine was needed again"],["p95FullMachineReturnIntervalMs","p95 return interval",duration,()=>"95% of measured returns happened within this time"],["repeatFullMachineTurnPercent","Machine-requiring turns that returned",percent,()=>"These turns needed the full machine more than once"],["turnsWithoutFullMachinePercent","Turns completed without full machine",percent,()=>"Every observed execution call stayed lightweight"]];
  const detailNames = [["sessionsWithoutFullMachinePercent","Sessions completed without full machine",percent],["turnsAnalyzed","Turns analyzed",integer],["turnCoveragePercent","Execution-call turn coverage",percent],["fullMachineReturnIntervalSamples","Measured full-machine return intervals",integer],["medianCallsAfterFirstFullMachine","Median calls after first full-machine need",number],["medianObservedSpanAfterFirstFullMachineMs","Median observed span after first full-machine need",duration],["p95ObservedSpanAfterFirstFullMachineMs","p95 observed span after first full-machine need",duration]];
  let report, savedUrl;
  const fail = message => { errorBox.textContent = message; errorBox.classList.add("visible"); };
  const postText = () => report.medianFullMachineReturnIntervalMs == null
    ? "My coding agent runtime report."
    : "My coding agent needs a full machine again every "+duration(report.medianFullMachineReturnIntervalMs)+" (median). 95% of measured returns happen within "+duration(report.p95FullMachineReturnIntervalMs)+".";
  const shareUrl = url => "https://x.com/intent/post?text="+encodeURIComponent(postText())+"&url="+encodeURIComponent(url);
  try {
    const encoded = new URLSearchParams(location.hash.slice(1)).get("data");
    if (!encoded) throw new Error("No report was found in this link. Run the CLI again to create one.");
    const base64 = encoded.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(encoded.length/4)*4,"=");
    report = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0))));
    for (const [key,label,format,context] of findingNames) {
      const card = document.createElement("article"), value = document.createElement("strong"), copy = document.createElement("div"), name = document.createElement("span"), note = document.createElement("p");
      card.className = "finding"; copy.className = "finding-copy"; value.textContent = format(report[key]); name.textContent = label; note.textContent = context(); copy.append(name,note); card.append(value,copy); findings.append(card);
    }
    for (const [key,label,format] of detailNames) {
      const row = document.createElement("div"), name = document.createElement("dt"), value = document.createElement("dd");
      row.className = "detail-row"; name.textContent = label; value.textContent = format(report[key]); row.append(name,value); details.append(row);
    }
    headline.textContent = report.medianFullMachineReturnIntervalMs == null
      ? integer(report.executionCalls)+" execution calls, mapped."
      : "Full machine needed again every "+duration(report.medianFullMachineReturnIntervalMs)+".";
    lede.textContent = report.medianFullMachineReturnIntervalMs == null
      ? "Your complete coding-agent runtime report."
      : "95% of measured returns happened within "+duration(report.p95FullMachineReturnIntervalMs)+".";
    button.disabled = false;
  } catch (error) {
    button.disabled = true;
    fail(error instanceof Error ? error.message : "This report link is invalid.");
  }
  button.addEventListener("click", async () => {
    const shareWindow = window.open("about:blank", "_blank");
    if (savedUrl) {
      if (shareWindow) shareWindow.location.replace(shareUrl(savedUrl));
      else location.assign(shareUrl(savedUrl));
      return;
    }
    button.disabled = true; button.textContent = "Saving page…"; errorBox.classList.remove("visible");
    try {
      const response = await fetch(${JSON.stringify(REPORT_API_PATH)}, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(report) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The page could not be saved.");
      savedUrl = result.url;
      history.replaceState(null, "", savedUrl);
      button.disabled = false; button.textContent = "Share on X ↗";
      if (shareWindow) shareWindow.location.replace(shareUrl(savedUrl));
      else location.assign(shareUrl(savedUrl));
    } catch (error) {
      if (shareWindow) shareWindow.close();
      button.disabled = false; button.textContent = "Save page and share on X ↗";
      fail(error instanceof Error ? error.message : "The page could not be saved.");
    }
  });
`

export function renderSharePage(nonce: string): string {
  return documentShell(
    "Coding Agent Machine Demand",
    `<main class="shell"><div class="reveal">${mast()}<p class="eyebrow">Agent runtime report</p><h1 id="report-headline">Runtime report.</h1><p class="lede" id="report-lede">Your complete coding-agent machine-demand report.</p></div><div class="reveal two report-actions"><button class="button" id="save-share" disabled>Save page and share on X ↗</button>${measureCommand()}</div><div class="reveal three"><section aria-labelledby="findings-title"><div class="section-head"><span id="findings-title">Main findings</span><span>At a glance</span></div><div class="finding-grid" id="report-findings"></div></section><section class="details-panel" aria-labelledby="details-title"><div class="section-head"><span id="details-title">Report details</span><span>7 metrics</span></div><dl class="detail-list" id="report-details"></dl></section>${placementDefinition()}</div><div id="error" class="error" role="alert"></div></main><script nonce="${nonce}">${shareScript}</script>`,
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
  const head = `<meta name="robots" content="noindex, follow"><link rel="canonical" href="${escapeHtml(pageUrl)}"><meta name="description" content="Coding-agent machine-demand report"><meta property="og:type" content="website"><meta property="og:title" content="${title}"><meta property="og:description" content="${escapeHtml(postText)}"><meta property="og:url" content="${escapeHtml(pageUrl)}"><meta property="og:image" content="${escapeHtml(imageUrl)}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${escapeHtml(postText)}"><meta name="twitter:image" content="${escapeHtml(imageUrl)}">`
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
  return documentShell(
    title,
    `<main class="shell"><div class="reveal">${mast()}<p class="eyebrow">Saved report / ${escapeHtml(created)}</p><h1>${escapeHtml(headline)}</h1><p class="lede">${escapeHtml(lede)}</p></div><div class="reveal two report-actions"><a class="button" href="${escapeHtml(xUrl)}" target="_blank" rel="noopener noreferrer">Share on X ↗</a>${measureCommand()}</div><div class="reveal three">${reportMetrics(report)}</div></main><script nonce="${nonce}">${copyCommandScript}</script>`,
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
