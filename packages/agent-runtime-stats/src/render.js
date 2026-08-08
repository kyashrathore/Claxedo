function percent(value, total) {
  return total ? `${((value * 100) / total).toFixed(2)}%` : "—"
}

function seconds(value) {
  return value == null ? "unavailable" : `${(value / 1000).toFixed(1)}s`
}

function number(value) {
  return value == null ? "unavailable" : value.toFixed(1).replace(/\.0$/, "")
}

function table(headers, rows, right = []) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index] ?? "").length)),
  )
  const border = (left, middle, rightEdge) =>
    left + widths.map((width) => "─".repeat(width + 2)).join(middle) + rightEdge
  const line = (row) =>
    `│${row
      .map((cell, index) => {
        const value = String(cell ?? "")
        return ` ${right.includes(index) ? value.padStart(widths[index]) : value.padEnd(widths[index])} `
      })
      .join("│")}│`
  return [border("┌", "┬", "┐"), line(headers), border("├", "┼", "┤"), ...rows.map(line), border("└", "┴", "┘")].join(
    "\n",
  )
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

function reportRows(analysis, verbose) {
  const total = analysis.calls.total
  const demand = analysis.full_machine_demand
  const gaps = demand.time_between_calls
  const resolvedSessions = analysis.sessions.requiring_full_machine + analysis.sessions.just_bash_only
  const resolvedTurns = analysis.turns.with_resolved_runtime
  const sample = (count, unit) =>
    count ? `${count.toLocaleString("en-US")} ${count === 1 ? unit.replace(/s$/, "") : unit}` : "no samples"
  return [
    [
      "Sessions analyzed (with execution calls)",
      analysis.sessions.with_execution_calls.toLocaleString("en-US"),
      percent(analysis.sessions.with_execution_calls, analysis.sessions.total),
      "of discovered",
    ],
    ["Sessions discovered", analysis.sessions.total.toLocaleString("en-US"), "—", "—"],
    [
      "Sessions requiring full machine",
      analysis.sessions.requiring_full_machine.toLocaleString("en-US"),
      percent(analysis.sessions.requiring_full_machine, resolvedSessions),
      "of resolved sessions",
    ],
    [
      "Sessions with unresolved runtime only",
      analysis.sessions.unresolved_runtime_only.toLocaleString("en-US"),
      percent(analysis.sessions.unresolved_runtime_only, analysis.sessions.with_execution_calls),
      "of observed",
    ],
    [
      "Observed just-bash-only sessions",
      analysis.sessions.just_bash_only.toLocaleString("en-US"),
      percent(analysis.sessions.just_bash_only, resolvedSessions),
      "of resolved sessions",
    ],
    [
      "Sessions without observed execution calls",
      analysis.sessions.without_execution_calls.toLocaleString("en-US"),
      percent(analysis.sessions.without_execution_calls, analysis.sessions.total),
      "of discovered",
    ],
    [
      "Turns analyzed (resolved runtime)",
      resolvedTurns.toLocaleString("en-US"),
      percent(resolvedTurns, analysis.turns.total),
      "of turns with IDs",
    ],
    [
      "Turns requiring full machine",
      analysis.turns.requiring_full_machine.toLocaleString("en-US"),
      percent(analysis.turns.requiring_full_machine, resolvedTurns),
      "of resolved turns",
    ],
    [
      "Turns completed without full machine",
      analysis.turns.just_bash_only.toLocaleString("en-US"),
      percent(analysis.turns.just_bash_only, resolvedTurns),
      "of resolved turns",
    ],
    [
      "Full-machine turns needing it again",
      analysis.turns.with_repeated_full_machine_calls.toLocaleString("en-US"),
      percent(analysis.turns.with_repeated_full_machine_calls, analysis.turns.requiring_full_machine),
      "of full-machine turns",
    ],
    [
      "Execution-call turn coverage",
      analysis.turns.execution_calls_covered.toLocaleString("en-US"),
      percent(analysis.turns.execution_calls_covered, total),
      "of execution calls",
    ],
    [
      "Median calls after first full-machine need",
      number(demand.calls_after_first_full_machine.median),
      "—",
      sample(demand.calls_after_first_full_machine.samples, "turns"),
    ],
    [
      "Median observed span after first full-machine need",
      seconds(demand.observed_span_after_first_full_machine.median_ms),
      "—",
      sample(demand.observed_span_after_first_full_machine.samples, "turns"),
    ],
    [
      "p95 observed span after first full-machine need",
      seconds(demand.observed_span_after_first_full_machine.p95_ms),
      "—",
      sample(demand.observed_span_after_first_full_machine.samples, "turns"),
    ],
    [
      verbose ? "Median lead before first full-machine call" : "Median first-call lead",
      seconds(demand.first_call_lead.median_ms),
      "—",
      sample(demand.first_call_lead.samples, "turns"),
    ],
    [
      verbose ? "p95 lead before first full-machine call" : "p95 first-call lead",
      seconds(demand.first_call_lead.p95_ms),
      "—",
      sample(demand.first_call_lead.samples, "turns"),
    ],
    [
      "Median full-machine call duration",
      seconds(demand.call_duration.median_ms),
      "—",
      sample(demand.call_duration.samples, "calls"),
    ],
    [
      "p95 full-machine call duration",
      seconds(demand.call_duration.p95_ms),
      "—",
      sample(demand.call_duration.samples, "calls"),
    ],
    [
      "Median full-machine calls per requiring session",
      number(demand.calls_per_requiring_session.median),
      "—",
      sample(demand.calls_per_requiring_session.samples, "sessions"),
    ],
    [
      "p95 full-machine calls per requiring session",
      number(demand.calls_per_requiring_session.p95),
      "—",
      sample(demand.calls_per_requiring_session.samples, "sessions"),
    ],
    [
      verbose ? "Median time before agent needs full machine again" : "Median full-machine interval",
      seconds(gaps.median_ms),
      "—",
      sample(gaps.samples, "gaps"),
    ],
    [
      verbose ? "p95 time before agent needs full machine again" : "p95 full-machine interval",
      seconds(gaps.p95_ms),
      "—",
      sample(gaps.samples, "gaps"),
    ],
    ...Object.entries(gaps.longer_than).map(([threshold, value]) => [
      `Gaps longer than ${Number.parseInt(threshold, 10) / 1000}s`,
      value.count.toLocaleString("en-US"),
      value.percent == null ? "—" : `${value.percent.toFixed(2)}%`,
      value.percent == null ? "no measured gaps" : "of measured gaps",
    ]),
    ["Total execution calls", total.toLocaleString("en-US"), total ? "100%" : "—", "—"],
    [
      "Classified runtime coverage",
      (analysis.calls.bash + analysis.calls.vm).toLocaleString("en-US"),
      percent(analysis.calls.bash + analysis.calls.vm, total),
      "of execution calls",
    ],
    ["Can run in just-bash", analysis.calls.bash.toLocaleString("en-US"), percent(analysis.calls.bash, total), "—"],
    [
      "Full workspace VM required today",
      analysis.calls.vm.toLocaleString("en-US"),
      percent(analysis.calls.vm, total),
      "—",
    ],
    ...bucketRows(analysis.buckets.vm, total, analysis.calls.vm, "full-machine"),
    ["Runtime unresolved", analysis.calls.unknown.toLocaleString("en-US"), percent(analysis.calls.unknown, total), "—"],
    ...bucketRows(analysis.buckets.unknown, total, analysis.calls.unknown, "unresolved"),
  ]
}

function wrap(text, columns) {
  const width = Math.max(10, Math.floor(columns))
  const words = text.split(/\s+/).filter(Boolean)
  const lines = []
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
  return lines.join("\n")
}

function stacked(rows, columns) {
  return rows
    .map(([label, value, share, details]) => {
      const values = [value]
      if (share !== "—") values.push(details === "—" ? share : `${share} ${details}`)
      else if (details !== "—") values.push(details)
      return wrap(`${label}: ${values.join(" · ")}`, columns)
    })
    .join("\n")
}

export function renderTable(analysis, terminalColumns = 100) {
  const requestedColumns = Number.isFinite(terminalColumns) && terminalColumns > 0 ? terminalColumns : 100
  const columns = Math.max(10, Math.floor(requestedColumns))
  const rows = reportRows(analysis, columns >= 110)
  const tabular = table(["Runtime / metric", "Value / calls", "Share", "Details"], rows, [1, 2])
  const report =
    Math.max(...tabular.split("\n").map((line) => line.length)) <= columns ? tabular : stacked(rows, columns)
  const definition =
    "Full-machine interval: within one agent turn, from a VM-required call ending until the next VM-required call starts."
  const lead =
    "First-call lead: within one agent turn, from the first timestamped execution call until the first full-machine call starts."
  const observedSpan =
    "Observed span after first full-machine need: from that call starting through the last timestamped execution call in the turn; it is not the complete turn duration."
  const readiness =
    "Environment readiness is not measured: provisioning, synchronization, cache restoration, and service startup require platform telemetry."
  const tiers =
    "Classifier assumptions: Node-hosted just-bash command manifest with configured, allowlisted network access. Unknown commands remain unresolved."
  const generatedCode =
    "* Generated code execution is counted as full-machine because running agent-generated code crosses the isolation boundary, even when an optional just-bash runtime exists."
  const sources = analysis.sources ?? []
  const sourceStatus = sources.length
    ? `Sources: ${sources.map((source) => `${source.harness} ${source.status} (${source.stores})`).join("; ")}.`
    : null
  const partialSources = sources.filter((source) => source.status === "partial")
  const partial = partialSources.length
    ? `Partial coverage: ${partialSources.map((source) => `${source.harness}: ${source.note ?? "some records are unavailable"}`).join("; ")}`
    : null
  const issues = [...(analysis.errors ?? []), ...(analysis.warnings ?? [])]
  const issueSummary = issues.length
    ? `Read issues (${issues.length}): ${issues.map((issue) => `${issue.harness}: ${issue.message}`).join("; ")}`
    : null
  const empty =
    analysis.sessions.total === 0
      ? "No transcript sessions were found."
      : analysis.calls.total === 0
        ? "No execution calls were found in the discovered sessions."
        : null
  const notes = [
    empty,
    observedSpan,
    definition,
    lead,
    readiness,
    tiers,
    generatedCode,
    sourceStatus,
    partial,
    issueSummary,
  ]
    .filter(Boolean)
    .map((note) => wrap(note, columns))
    .join("\n")
  return `${report}\n\n${notes}`
}

export function sharePrompt(analysis, baseUrl, hyperlinks = false) {
  if (!baseUrl || !analysis.calls.total) return null
  const ratio = (value, total) => (total ? (value * 100) / total : null)
  const resolvedSessions = analysis.sessions.requiring_full_machine + analysis.sessions.just_bash_only
  const resolvedTurns = analysis.turns.with_resolved_runtime
  const payload = {
    schemaVersion: 2,
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
    medianCallsAfterFirstFullMachine: analysis.full_machine_demand.calls_after_first_full_machine.median,
    medianObservedSpanAfterFirstFullMachineMs:
      analysis.full_machine_demand.observed_span_after_first_full_machine.median_ms,
    p95ObservedSpanAfterFirstFullMachineMs: analysis.full_machine_demand.observed_span_after_first_full_machine.p95_ms,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const url = `${baseUrl.replace(/\/$/, "")}/share#data=${encoded}`
  const action = hyperlinks ? `\u001B]8;;${url}\u001B\\[ Share results ]\u001B]8;;\u001B\\` : url
  return `Share these anonymous aggregate stats:\n${action}\nNothing uploads until you press Share results in the browser.`
}
