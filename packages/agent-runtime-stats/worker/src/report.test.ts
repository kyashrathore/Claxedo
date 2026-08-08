import { describe, expect, test } from "bun:test"
import {
  InvalidReportError,
  detailMetricRows,
  formatDuration,
  headlineMetricRows,
  metricRows,
  parseReport,
} from "./report"

const sample = {
  schemaVersion: 2,
  sessionsAnalyzed: 2_178,
  executionCalls: 347_214,
  sessionsWithoutFullMachinePercent: 18.25,
  turnsAnalyzed: 12_420,
  turnCoveragePercent: 91.6,
  turnsWithoutFullMachinePercent: 37.5,
  repeatFullMachineTurnPercent: 72.4,
  medianCallsAfterFirstFullMachine: 6,
  medianObservedSpanAfterFirstFullMachineMs: 45_500,
  p95ObservedSpanAfterFirstFullMachineMs: 301_200,
}

describe("report contract", () => {
  test("accepts only the aggregate turn/session placement metrics", () => {
    const report = parseReport(sample)
    expect(metricRows(report)).toEqual([
      ["Sessions analyzed", "2,178"],
      ["Execution calls", "347,214"],
      ["Sessions completed without full machine", "18.25%"],
      ["Turns analyzed", "12,420"],
      ["Execution-call turn coverage", "91.60%"],
      ["Turns completed without full machine", "37.50%"],
      ["Full-machine turns needing it again", "72.40%"],
      ["Median calls after first full-machine need", "6"],
      ["Median observed span after first full-machine need", "45.5s"],
      ["p95 observed span after first full-machine need", "301.2s"],
    ])
    expect(headlineMetricRows(report)).toEqual(metricRows(report).slice(0, 3))
    expect(detailMetricRows(report)).toEqual(metricRows(report).slice(3))
  })

  test("rejects identifying, obsolete, and internally inconsistent payloads", () => {
    expect(() => parseReport({ ...sample, schemaVersion: 1 })).toThrow("schemaVersion must be 2")
    expect(() => parseReport({ ...sample, sessionsAnalyzed: -1 })).toThrow(InvalidReportError)
    expect(() => parseReport({ ...sample, repository: "secret/project" })).toThrow("Unexpected report field")
    expect(() => parseReport({ ...sample, justBashPercent: 64.84 })).toThrow("Unexpected report field")
    expect(() => parseReport({ ...sample, turnsAnalyzed: 0, turnsWithoutFullMachinePercent: 1 })).toThrow(
      "must be null",
    )
    expect(() =>
      parseReport({
        ...sample,
        medianObservedSpanAfterFirstFullMachineMs: 400_000,
        p95ObservedSpanAfterFirstFullMachineMs: 300_000,
      }),
    ).toThrow("cannot be greater")
    expect(formatDuration(null)).toBe("Unavailable")
  })
})
