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

function bucketRows(buckets, total, tierTotal) {
  return Object.entries(buckets)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([bucket, count]) => [
      `  ↳ ${bucket}`,
      count.toLocaleString("en-US"),
      percent(count, total),
      `${percent(count, tierTotal)} of full-machine`,
    ])
}

function reportRows(analysis, verbose) {
  const total = analysis.calls.total
  const demand = analysis.full_machine_demand
  const gaps = demand.time_between_calls
  const sample = (count, unit) =>
    count ? `${count.toLocaleString("en-US")} ${count === 1 ? unit.replace(/s$/, "") : unit}` : "no samples"
  return [
    ["Sessions analyzed", analysis.sessions.total.toLocaleString("en-US"), "—", "—"],
    [
      "Sessions with execution calls",
      analysis.sessions.with_execution_calls.toLocaleString("en-US"),
      percent(analysis.sessions.with_execution_calls, analysis.sessions.total),
      "of discovered",
    ],
    [
      "Sessions requiring full machine",
      analysis.sessions.requiring_full_machine.toLocaleString("en-US"),
      percent(analysis.sessions.requiring_full_machine, analysis.sessions.with_execution_calls),
      "of observed",
    ],
    [
      "Observed just-bash-only sessions",
      analysis.sessions.just_bash_only.toLocaleString("en-US"),
      percent(analysis.sessions.just_bash_only, analysis.sessions.with_execution_calls),
      "of observed",
    ],
    [
      "Sessions without observed execution calls",
      analysis.sessions.without_execution_calls.toLocaleString("en-US"),
      percent(analysis.sessions.without_execution_calls, analysis.sessions.total),
      "of discovered",
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
    ["Total execution calls", total.toLocaleString("en-US"), "100%", "—"],
    ["Can run in just-bash", analysis.calls.bash.toLocaleString("en-US"), percent(analysis.calls.bash, total), "—"],
    [
      "Full workspace VM required today",
      analysis.calls.vm.toLocaleString("en-US"),
      percent(analysis.calls.vm, total),
      "—",
    ],
    ...bucketRows(analysis.buckets.vm, total, analysis.calls.vm),
  ]
}

function wrap(text, columns) {
  const width = Math.max(30, columns)
  const words = text.split(/\s+/)
  const lines = []
  let line = ""
  for (const word of words) {
    if (!line || line.length + word.length + 1 <= width) line += `${line ? " " : ""}${word}`
    else {
      lines.push(line)
      line = `  ${word}`
    }
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
  const columns = Math.max(30, requestedColumns)
  const rows = reportRows(analysis, columns >= 110)
  const tabular = table(["Runtime / metric", "Value / calls", "Share", "Details"], rows, [1, 2])
  const report =
    Math.max(...tabular.split("\n").map((line) => line.length)) <= columns ? tabular : stacked(rows, columns)
  const definition =
    "Full-machine interval: within one agent turn, from a VM-required call ending until the next VM-required call starts."
  const lead =
    "First-call lead: within one agent turn, from the first timestamped execution call until the first full-machine call starts."
  const readiness =
    "Environment readiness is not measured: provisioning, synchronization, cache restoration, and service startup require platform telemetry."
  const tiers =
    "Minimum runtimes: just-bash handles files, shell utilities, JavaScript, configured network/API access, and emulated host bindings; a full VM adds real processes, repository state, services, and local browsers."
  const partial =
    "Partial coverage: Cursor hides some tool records in proprietary protobuf; Antigravity uses protobuf without a stable public schema."
  return `${report}\n\n${wrap(definition, columns)}\n${wrap(lead, columns)}\n${wrap(readiness, columns)}\n${wrap(tiers, columns)}\n${wrap(partial, columns)}`
}

export function sharePrompt(
  analysis,
  baseUrl = "https://agent-runtime-stats-share.kanusdlp.workers.dev",
  hyperlinks = false,
) {
  const ratio = (value) => (analysis.calls.total ? (value * 100) / analysis.calls.total : null)
  const payload = {
    schemaVersion: 1,
    sessionsAnalyzed: analysis.sessions.total,
    executionCalls: analysis.calls.total,
    justBashPercent: ratio(analysis.calls.bash),
    fullVmPercent: ratio(analysis.calls.vm),
    medianTimeBeforeFullMachineMs: analysis.full_machine_demand.time_between_calls.median_ms,
    p95TimeBeforeFullMachineMs: analysis.full_machine_demand.time_between_calls.p95_ms,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const url = `${baseUrl.replace(/\/$/, "")}/share#data=${encoded}`
  const action = hyperlinks ? `\u001B]8;;${url}\u001B\\[ Share results ]\u001B]8;;\u001B\\` : url
  return `Share these anonymous aggregate stats:\n${action}\nNothing uploads until you press Share results in the browser.`
}
