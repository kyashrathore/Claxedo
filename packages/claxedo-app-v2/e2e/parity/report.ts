import fs from "node:fs/promises"
import path from "node:path"

export type ShotResult = {
  screen: string
  size: string
  changedRatio: number
  notes: { v1?: string; v2?: string }
  files: { v1: string; v2: string; side: string }
}

function escape(text: string) {
  return text.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] ?? character)
}

function row(result: ShotResult) {
  const percent = (result.changedRatio * 100).toFixed(2)
  const tone = result.changedRatio < 0.005 ? "same" : result.changedRatio < 0.05 ? "near" : "far"
  const notes = (["v1", "v2"] as const)
    .flatMap((app) => (result.notes[app] ? [`<div class="note">${app}: ${escape(result.notes[app] ?? "")}</div>`] : []))
    .join("")
  return `<section id="${result.screen}-${result.size}">
  <h2>${escape(result.screen)} <small>${result.size}</small> <span class="${tone}">${percent}%</span></h2>
  ${notes}
  <a href="${result.files.side}"><img src="${result.files.side}" alt="${escape(result.screen)} ${result.size}: v1, v2, diff" loading="lazy"></a>
  <p><a href="${result.files.v1}">v1</a> · <a href="${result.files.v2}">v2</a></p>
</section>`
}

function page(results: ShotResult[], startedAt: Date) {
  const sorted = [...results].sort((a, b) => b.changedRatio - a.changedRatio)
  const index = sorted.map((result) => `<li><a href="#${result.screen}-${result.size}">${escape(result.screen)} ${result.size}</a> ${(result.changedRatio * 100).toFixed(2)}%${result.notes.v2 ? " · v2 step failed" : ""}</li>`)
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>v1 vs v2 parity</title>
<style>
body{font:14px/1.5 -apple-system,sans-serif;margin:24px;background:#fafafa;color:#1a1c1f}
img{max-width:100%;border:1px solid #ddd}
section{margin:32px 0}
.same{color:#1a7f37}.near{color:#9a6700}.far{color:#cf222e}
.note{color:#cf222e;font-family:ui-monospace,monospace;font-size:12px}
</style></head><body>
<h1>v1 vs v2 parity</h1>
<p>Captured ${startedAt.toISOString()} from one seeded stack. Most different first. A red note is a step that could not run on that app.</p>
<ol>${index.join("")}</ol>
${sorted.map(row).join("\n")}
</body></html>`
}

export async function writeReport(outDir: string, results: ShotResult[], startedAt: Date) {
  await fs.writeFile(path.join(outDir, "results.json"), JSON.stringify(results, null, 2))
  const file = path.join(outDir, "index.html")
  await fs.writeFile(file, page(results, startedAt))
  return file
}
