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

function measureTurn(turn, gaps, firstCallLeads) {
  const calls = turn.fullMachineCalls
  if (!calls?.length) return
  calls.sort((left, right) => left.start - right.start)
  firstCallLeads.push(Math.max(0, calls[0].start - turn.firstExecutionStart))
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
      without_execution_calls: 0,
    },
    calls: { total: 0, bash: 0, vm: 0 },
    buckets: { vm: {} },
    harnesses: {},
    full_machine_demand: {},
  }
  const callsPerRequiringSession = []
  const callDurations = []
  const gaps = []
  const firstCallLeads = []
  for (const session of sessions) {
    const harness = (analysis.harnesses[session.harness] ??= { sessions: 0, calls: 0 })
    harness.sessions++
    const turns = new Map()
    let executionCalls = 0
    let fullMachineCalls = 0
    for (const call of session.calls) {
      const classification = call.classification ?? classifyToolCall(call)
      if (classification.tier === "control") continue
      analysis.calls.total++
      analysis.calls[classification.tier]++
      harness.calls++
      executionCalls++
      let turn
      if (hasTimestamp(call.start) && call.turn_id != null) {
        turn = turns.get(call.turn_id)
        if (turn) turn.firstExecutionStart = Math.min(turn.firstExecutionStart, call.start)
        else {
          turn = { firstExecutionStart: call.start }
          turns.set(call.turn_id, turn)
        }
      }
      if (classification.tier === "vm") addBucket(analysis.buckets.vm, classification.bucket)
      if (classification.tier === "vm") {
        fullMachineCalls++
        if (hasTimestamp(call.start) && hasTimestamp(call.end) && call.end >= call.start) {
          callDurations.push(call.end - call.start)
        }
      }
      if (classification.tier === "vm" && turn) (turn.fullMachineCalls ??= []).push(call)
    }
    for (const turn of turns.values()) measureTurn(turn, gaps, firstCallLeads)
    if (fullMachineCalls) {
      analysis.sessions.requiring_full_machine++
      callsPerRequiringSession.push(fullMachineCalls)
    } else if (executionCalls) {
      analysis.sessions.just_bash_only++
    } else analysis.sessions.without_execution_calls++
  }
  analysis.sessions.with_execution_calls = analysis.sessions.requiring_full_machine + analysis.sessions.just_bash_only
  const timeBetweenCalls = durationSummary(gaps)
  timeBetweenCalls.longer_than = gapThresholds(gaps)
  analysis.full_machine_demand = {
    calls_per_requiring_session: summary(callsPerRequiringSession),
    first_call_lead: durationSummary(firstCallLeads),
    call_duration: durationSummary(callDurations),
    time_between_calls: timeBetweenCalls,
  }
  return analysis
}
