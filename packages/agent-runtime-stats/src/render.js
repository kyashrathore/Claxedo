import { SHARE_PATH } from "./share-contract.js"

function percent(value, total) {
  return total ? `${((value * 100) / total).toFixed(2)}%` : "—"
}

function seconds(value) {
  return value == null ? "unavailable" : `${(value / 1000).toFixed(1)}s`
}

function number(value) {
  return value == null ? "unavailable" : value.toFixed(1).replace(/\.0$/, "")
}

const ANSI = {
  reset: "\u001B[0m",
  boldCyan: "\u001B[1;36m",
  dim: "\u001B[2m",
  gray: "\u001B[90m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  red: "\u001B[31m",
}

function paint(text, color, enabled) {
  return enabled ? `${color}${text}${ANSI.reset}` : text
}

function wrapLines(text, width) {
  width = Math.max(1, Math.floor(width))
  const lines = []
  for (const paragraph of String(text).split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    let line = ""
    for (let word of words) {
      if (line && line.length + word.length + 1 > width) {
        lines.push(line)
        line = ""
      }
      while (word.length > width) {
        if (line) {
          lines.push(line)
          line = ""
        }
        lines.push(word.slice(0, width))
        word = word.slice(width)
      }
      if (word) line += `${line ? " " : ""}${word}`
    }
    if (line) lines.push(line)
    else if (!words.length) lines.push("")
  }
  return lines.length ? lines : [""]
}

function naturalWidths(headers, rows) {
  return headers.map((header, index) =>
    Math.max(
      ...[header, ...rows.map((row) => row[index] ?? "")].flatMap((cell) =>
        String(cell)
          .split("\n")
          .map((line) => line.length),
      ),
    ),
  )
}

function tableWidth(widths) {
  return widths.reduce((total, width) => total + width, 0) + widths.length * 3 + 1
}

function gridTable(headers, rows, widths, right = [], colors = false, separateRows = false) {
  const border = (left, middle, rightEdge) =>
    paint(left + widths.map((width) => "─".repeat(width + 2)).join(middle) + rightEdge, ANSI.dim, colors)
  const vertical = paint("│", ANSI.dim, colors)
  const renderRow = (row, header = false) => {
    const cells = widths.map((width, index) => wrapLines(row[index] ?? "", width))
    const height = Math.max(...cells.map((cell) => cell.length))
    return Array.from({ length: height }, (_, lineIndex) => {
      const values = cells.map((cell, index) => {
        const value = cell[lineIndex] ?? ""
        const padded = right.includes(index) ? value.padStart(widths[index]) : value.padEnd(widths[index])
        return header ? paint(` ${padded} `, ANSI.boldCyan, colors) : ` ${padded} `
      })
      return `${vertical}${values.join(vertical)}${vertical}`
    })
  }
  const lines = [border("┌", "┬", "┐"), ...renderRow(headers, true), border("├", "┼", "┤")]
  rows.forEach((row, index) => {
    lines.push(...renderRow(row))
    if (separateRows && index < rows.length - 1) lines.push(border("├", "┼", "┤"))
  })
  lines.push(border("└", "┴", "┘"))
  return lines.join("\n")
}

function bucketRows(buckets, total, tierTotal, tierName) {
  return Object.entries(buckets)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([bucket, count]) => [
      `  ↳ ${bucket}`,
      count.toLocaleString("en-US"),
      percent(count, total),
      `${percent(count, tierTotal)} of ${tierName}`,
    ])
}

function reportRows(analysis) {
  const total = analysis.calls.total
  const demand = analysis.full_machine_demand
  const gaps = demand.time_between_calls
  const resolvedSessions = analysis.sessions.requiring_full_machine + analysis.sessions.just_bash_only
  const sample = (count, unit) =>
    count ? `${count.toLocaleString("en-US")} ${count === 1 ? unit.replace(/s$/, "") : unit}` : "no samples"
  return [
    [
      "Sessions analyzed",
      `${analysis.sessions.with_execution_calls.toLocaleString("en-US")} / ${analysis.sessions.total.toLocaleString("en-US")}`,
      percent(analysis.sessions.with_execution_calls, analysis.sessions.total),
      "with execution calls / discovered",
    ],
    [
      "Sessions requiring full machine",
      analysis.sessions.requiring_full_machine.toLocaleString("en-US"),
      percent(analysis.sessions.requiring_full_machine, resolvedSessions),
      `of ${resolvedSessions.toLocaleString("en-US")} classified sessions`,
    ],
    ["Total execution calls", total.toLocaleString("en-US"), total ? "100%" : "—", "—"],
    ["Can run in just-bash", analysis.calls.bash.toLocaleString("en-US"), percent(analysis.calls.bash, total), "—"],
    ["Full workspace VM required", analysis.calls.vm.toLocaleString("en-US"), percent(analysis.calls.vm, total), "—"],
    ...bucketRows(analysis.buckets.vm, total, analysis.calls.vm, "full-machine"),
    ["Unclassified", analysis.calls.unknown.toLocaleString("en-US"), percent(analysis.calls.unknown, total), "—"],
    ["Median interval before machine needed again", seconds(gaps.median_ms), "—", sample(gaps.samples, "intervals")],
    ["p95 interval before machine needed again", seconds(gaps.p95_ms), "—", sample(gaps.samples, "intervals")],
    [
      "Median calls after first machine need",
      number(demand.calls_after_first_full_machine.median),
      "—",
      sample(demand.calls_after_first_full_machine.samples, "turns"),
    ],
    [
      "Median observed work after first machine need",
      seconds(demand.observed_span_after_first_full_machine.median_ms),
      "—",
      sample(demand.observed_span_after_first_full_machine.samples, "turns"),
    ],
    [
      "p95 observed work after first machine need",
      seconds(demand.observed_span_after_first_full_machine.p95_ms),
      "—",
      sample(demand.observed_span_after_first_full_machine.samples, "turns"),
    ],
  ]
}

function compactRows(rows) {
  return rows.map(([label, value, share, details]) => {
    const context =
      share === "—"
        ? details
        : details === "—"
          ? share
          : /^\d|^—/.test(details)
            ? `${share} overall\n${details}`
            : `${share} ${details}`
    return [label, context === "—" ? value : `${value}\n${context}`]
  })
}

function compactWidths(columns) {
  const contentWidth = Math.max(3, columns - 7)
  const metricWidth = Math.max(1, Math.floor(contentWidth * 0.6))
  return [metricWidth, Math.max(1, contentWidth - metricWidth)]
}

function renderNotes(notes, columns, colors) {
  if (!notes.length) return ""
  const labelColor = (tone) =>
    tone === "warning" ? ANSI.yellow : tone === "error" ? ANSI.red : tone === "source" ? ANSI.green : ANSI.boldCyan
  const rendered = notes.map(({ label, text, tone }) => {
    const heading = wrapLines(label, columns)
      .map((line) => paint(line, labelColor(tone), colors))
      .join("\n")
    const body = wrapLines(text, columns - 2)
      .map((line) => paint(`  ${line}`, ANSI.gray, colors))
      .join("\n")
    return `${heading}\n${body}`
  })
  return `${paint("NOTES", ANSI.dim, colors)}\n\n${rendered.join("\n\n")}`
}

export function renderTable(analysis, terminalColumns = 100, colors = false) {
  const requestedColumns = Number.isFinite(terminalColumns) && terminalColumns > 0 ? terminalColumns : 100
  const columns = Math.max(10, Math.floor(requestedColumns))
  const rows = reportRows(analysis)
  const wideHeaders = ["Runtime / metric", "Value / calls", "Share", "Details"]
  const wideWidths = naturalWidths(wideHeaders, rows)
  const report =
    tableWidth(wideWidths) <= columns
      ? gridTable(wideHeaders, rows, wideWidths, [1, 2], colors)
      : gridTable(["Metric", "Result"], compactRows(rows), compactWidths(columns), [1], colors, true)
  const definition = "Within one agent turn, from a VM-required call ending until the next VM-required call starts."
  const observedSpan =
    "From the first full-machine call starting through the last timestamped execution call in the turn. This is not the complete turn duration."
  const readiness =
    "Not measured here. Provisioning, synchronization, cache restoration, and service startup require platform telemetry."
  const tiers =
    "Assumes the Node-hosted just-bash command manifest with configured, allowlisted network access. Unclassified calls remain separate from both runtime tiers."
  const generatedCode =
    "Generated code execution is counted as full-machine because running agent-generated code crosses the isolation boundary, even when an optional just-bash runtime exists."
  const sources = analysis.sources ?? []
  const sourceStatus = sources.length
    ? `${sources.map((source) => `${source.harness} ${source.status} (${source.stores})`).join("; ")}.`
    : null
  const partialSources = sources.filter((source) => source.status === "partial")
  const partial = partialSources.length
    ? partialSources.map((source) => `${source.harness}: ${source.note ?? "some records are unavailable"}`).join("; ")
    : null
  const issues = [...(analysis.errors ?? []), ...(analysis.warnings ?? [])]
  const issueSummary = issues.length
    ? `${issues.length} total. ${issues.map((issue) => `${issue.harness}: ${issue.message}`).join("; ")}`
    : null
  const empty =
    analysis.sessions.total === 0
      ? "No transcript sessions were found."
      : analysis.calls.total === 0
        ? "No execution calls were found in the discovered sessions."
        : null
  const notes = [
    empty && { label: "DATA", text: empty, tone: "warning" },
    { label: "OBSERVED WORK", text: observedSpan },
    { label: "MACHINE INTERVAL", text: definition },
    { label: "ENVIRONMENT READINESS", text: readiness },
    { label: "CLASSIFIER", text: tiers },
    { label: "BOUNDARY *", text: generatedCode, tone: "warning" },
    sourceStatus && { label: "SOURCES", text: sourceStatus, tone: "source" },
    partial && { label: "PARTIAL COVERAGE", text: partial, tone: "warning" },
    issueSummary && { label: "READ ISSUES", text: issueSummary, tone: "error" },
  ].filter(Boolean)
  return `${report}\n\n${renderNotes(notes, columns, colors)}`
}

export function sharePrompt(analysis, baseUrl, hyperlinks = false) {
  if (!baseUrl || !analysis.calls.total) return null
  const ratio = (value, total) => (total ? (value * 100) / total : null)
  const resolvedSessions = analysis.sessions.requiring_full_machine + analysis.sessions.just_bash_only
  const resolvedTurns = analysis.turns.with_resolved_runtime
  const payload = {
    schemaVersion: 3,
    sessionsAnalyzed: resolvedSessions,
    executionCalls: analysis.calls.total,
    sessionsWithoutFullMachinePercent: ratio(analysis.sessions.just_bash_only, resolvedSessions),
    turnsAnalyzed: resolvedTurns,
    turnCoveragePercent: ratio(analysis.turns.execution_calls_covered, analysis.calls.total),
    turnsWithoutFullMachinePercent: ratio(analysis.turns.just_bash_only, resolvedTurns),
    repeatFullMachineTurnPercent: ratio(
      analysis.turns.with_repeated_full_machine_calls,
      analysis.turns.requiring_full_machine,
    ),
    fullMachineReturnIntervalSamples: analysis.full_machine_demand.time_between_calls.samples,
    medianFullMachineReturnIntervalMs: analysis.full_machine_demand.time_between_calls.median_ms,
    p95FullMachineReturnIntervalMs: analysis.full_machine_demand.time_between_calls.p95_ms,
    medianCallsAfterFirstFullMachine: analysis.full_machine_demand.calls_after_first_full_machine.median,
    medianObservedSpanAfterFirstFullMachineMs:
      analysis.full_machine_demand.observed_span_after_first_full_machine.median_ms,
    p95ObservedSpanAfterFirstFullMachineMs: analysis.full_machine_demand.observed_span_after_first_full_machine.p95_ms,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const url = `${baseUrl.replace(/\/$/, "")}${SHARE_PATH}#data=${encoded}`
  const action = hyperlinks ? `\u001B]8;;${url}\u001B\\[ Share results ]\u001B]8;;\u001B\\` : url
  return `Share these anonymous aggregate stats:\n${action}\nNothing uploads until you press Share results in the browser.`
}
