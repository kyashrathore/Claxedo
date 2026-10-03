import { asRecordOrEmpty as row } from "@claxedo/helpers/guards"
import { EMPTY_USAGE, piStep, type PiDurableTranslatorState, type PiStep, type PiUsageTotals } from "./state"

const count = (value: unknown) => typeof value === "number" ? value : 0

export function piUsageTotals(usage: unknown): PiUsageTotals {
  const state = row(usage)
  const buckets = [...Object.values(row(state.models)), ...Object.values(row(state.tools))].map(row)
  return buckets.reduce((total: PiUsageTotals, bucket) => ({
    input: total.input + count(bucket.input), output: total.output + count(bucket.output),
    reasoning: total.reasoning + count(bucket.reasoning),
    cacheRead: total.cacheRead + count(bucket.cacheRead), cacheWrite: total.cacheWrite + count(bucket.cacheWrite),
  }), EMPTY_USAGE)
}

export function piUsageChanged(state: PiDurableTranslatorState, frame: Record<string, unknown>): PiStep {
  const totals = piUsageTotals(frame.usage)
  const before = state.usage
  const input = totals.input - before.input
  const output = totals.output - before.output
  const reasoning = totals.reasoning - before.reasoning
  const cache = { read: totals.cacheRead - before.cacheRead, write: totals.cacheWrite - before.cacheWrite }
  if (input <= 0 && output <= 0 && cache.read <= 0 && cache.write <= 0) return piStep({ ...state, usage: totals })
  return piStep({ ...state, usage: totals }, [{
    type: "usage", contextSize: 0, contextUsed: input + cache.read + cache.write,
    observation: { kind: "delta", tokens: { input, output: output - reasoning, reasoning, cache } },
  }])
}
