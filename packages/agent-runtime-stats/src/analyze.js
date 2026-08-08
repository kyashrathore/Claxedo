import { classifyToolCall } from "./classify.js"

function quantile(values, percentile) {
  if (!values.length) return null
  const index = (values.length - 1) * percentile
  const low = Math.floor(index)
  const high = Math.ceil(index)
  return values[low] + (values[high] - values[low]) * (index - low)
}

function addBucket(buckets, name) {
  buckets[name] = (buckets[name] ?? 0) + 1
}

function summary(values) {
  values.sort((a, b) => a - b)
  return {
    samples: values.length,
    median: quantile(values, 0.5),
    p95: quantile(values, 0.95),
  }
}

function durationSummary(values) {
  const result = summary(values)
  return { samples: result.samples, median_ms: result.median, p95_ms: result.p95 }
}

function gapThresholds(gaps) {
  const thresholds = [30_000, 60_000, 120_000].map((threshold) => ({ threshold, count: 0 }))
  for (const gap of gaps) {
    for (const item of thresholds) item.count += Number(gap > item.threshold)
  }
  return Object.fromEntries(
    thresholds.map(({ threshold, count }) => [
      `${threshold}_ms`,
      { count, percent: gaps.length ? (count * 100) / gaps.length : null },
    ]),
  )
}

function hasTimestamp(value) {
  return Number.isFinite(value)
}

function measureTurn(turn, gaps, firstCallLeads, callsAfterFirstFullMachine, spansAfterFirstFullMachine) {
  const firstFullMachineIndex = turn.executionCalls.findIndex((call) => call.classification.tier === "vm")
  if (firstFullMachineIndex < 0) return
  callsAfterFirstFullMachine.push(turn.executionCalls.length - firstFullMachineIndex - 1)
  const firstFullMachine = turn.executionCalls[firstFullMachineIndex]
  if (hasTimestamp(firstFullMachine.start)) {
    const observedEnds = turn.executionCalls
      .slice(firstFullMachineIndex)
      .map((call) => (hasTimestamp(call.end) && call.end >= call.start ? call.end : call.start))
      .filter((timestamp) => hasTimestamp(timestamp) && timestamp >= firstFullMachine.start)
    if (observedEnds.length) {
      spansAfterFirstFullMachine.push(Math.max(...observedEnds) - firstFullMachine.start)
    }
  }
  const calls = turn.fullMachineCalls
  if (!calls.length) return
  calls.sort((left, right) => left.start - right.start)
  if (hasTimestamp(turn.firstExecutionStart)) {
    firstCallLeads.push(Math.max(0, calls[0].start - turn.firstExecutionStart))
  }
  let clusterEndKnown = hasTimestamp(calls[0].end) && calls[0].end >= calls[0].start
  let busyUntil = clusterEndKnown ? calls[0].end : calls[0].start
  for (let index = 1; index < calls.length; index++) {
    const call = calls[index]
    const endKnown = hasTimestamp(call.end) && call.end >= call.start
    const end = endKnown ? call.end : call.start
    if (!clusterEndKnown) {
      if (endKnown) busyUntil = Math.max(busyUntil, end)
      continue
    }
    if (call.start <= busyUntil) {
      if (endKnown) busyUntil = Math.max(busyUntil, end)
      else clusterEndKnown = false
    } else {
      gaps.push(call.start - busyUntil)
      busyUntil = end
      clusterEndKnown = endKnown
    }
  }
}

export function analyzeSessions(sessions) {
  const analysis = {
    sessions: {
      total: sessions.length,
      with_execution_calls: 0,
      requiring_full_machine: 0,
      just_bash_only: 0,
      unresolved_runtime_only: 0,
      without_execution_calls: 0,
    },
    turns: {
      total: 0,
      requiring_full_machine: 0,
      just_bash_only: 0,
      unresolved_runtime_only: 0,
      execution_calls_covered: 0,
      with_repeated_full_machine_calls: 0,
    },
    calls: { total: 0, bash: 0, vm: 0, unknown: 0 },
    buckets: { vm: {}, unknown: {} },
    harnesses: {},
    full_machine_demand: {},
  }
  const callsPerRequiringSession = []
  const callDurations = []
  const gaps = []
  const firstCallLeads = []
  const callsAfterFirstFullMachine = []
  const spansAfterFirstFullMachine = []
  for (const session of sessions) {
    const harness = (analysis.harnesses[session.harness] ??= { sessions: 0, calls: 0 })
    harness.sessions++
    const turns = new Map()
    let executionCalls = 0
    let fullMachineCalls = 0
    let unknownCalls = 0
    for (const call of session.calls) {
      const classification = call.classification ?? classifyToolCall(call)
      if (classification.tier === "control") continue
      analysis.calls.total++
      analysis.calls[classification.tier]++
      harness.calls++
      executionCalls++
      let turn
      if (call.turn_id != null) {
        turn = turns.get(call.turn_id)
        if (!turn) {
          turn = { firstExecutionStart: null, executionCalls: [], fullMachineCalls: [] }
          turns.set(call.turn_id, turn)
        }
        if (hasTimestamp(call.start)) {
          turn.firstExecutionStart = hasTimestamp(turn.firstExecutionStart)
            ? Math.min(turn.firstExecutionStart, call.start)
            : call.start
        }
        turn.executionCalls.push({ ...call, classification })
        analysis.turns.execution_calls_covered++
      }
      if (classification.tier === "vm") addBucket(analysis.buckets.vm, classification.bucket)
      if (classification.tier === "unknown") {
        unknownCalls++
        addBucket(analysis.buckets.unknown, classification.bucket)
      }
      if (classification.tier === "vm") {
        fullMachineCalls++
        if (hasTimestamp(call.start) && hasTimestamp(call.end) && call.end >= call.start) {
          callDurations.push(call.end - call.start)
        }
      }
      if (classification.tier === "vm" && turn && hasTimestamp(call.start)) turn.fullMachineCalls.push(call)
    }
    for (const turn of turns.values()) {
      analysis.turns.total++
      const fullMachineCount = turn.executionCalls.filter((call) => call.classification.tier === "vm").length
      const unknownCount = turn.executionCalls.filter((call) => call.classification.tier === "unknown").length
      if (fullMachineCount) {
        analysis.turns.requiring_full_machine++
        if (fullMachineCount > 1) analysis.turns.with_repeated_full_machine_calls++
      } else if (unknownCount) analysis.turns.unresolved_runtime_only++
      else analysis.turns.just_bash_only++
      measureTurn(turn, gaps, firstCallLeads, callsAfterFirstFullMachine, spansAfterFirstFullMachine)
    }
    if (fullMachineCalls) {
      analysis.sessions.requiring_full_machine++
      callsPerRequiringSession.push(fullMachineCalls)
    } else if (unknownCalls) {
      analysis.sessions.unresolved_runtime_only++
    } else if (executionCalls) {
      analysis.sessions.just_bash_only++
    } else analysis.sessions.without_execution_calls++
  }
  analysis.sessions.with_execution_calls =
    analysis.sessions.requiring_full_machine +
    analysis.sessions.just_bash_only +
    analysis.sessions.unresolved_runtime_only
  analysis.turns.with_resolved_runtime = analysis.turns.requiring_full_machine + analysis.turns.just_bash_only
  const timeBetweenCalls = durationSummary(gaps)
  timeBetweenCalls.longer_than = gapThresholds(gaps)
  analysis.full_machine_demand = {
    calls_per_requiring_session: summary(callsPerRequiringSession),
    first_call_lead: durationSummary(firstCallLeads),
    call_duration: durationSummary(callDurations),
    time_between_calls: timeBetweenCalls,
    calls_after_first_full_machine: summary(callsAfterFirstFullMachine),
    observed_span_after_first_full_machine: durationSummary(spansAfterFirstFullMachine),
  }
  return analysis
}
