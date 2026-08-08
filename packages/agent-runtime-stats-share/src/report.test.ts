import { describe, expect, test } from "bun:test"
import { InvalidReportError, formatDuration, metricRows, parseReport } from "./report"

const sample = {
  schemaVersion: 1,
  sessionsAnalyzed: 2_178,
  executionCalls: 347_214,
  justBashPercent: 69.16,
  fullVmPercent: 30.84,
  medianTimeBeforeFullMachineMs: 11_500,
  p95TimeBeforeFullMachineMs: 109_200,
}

describe("report contract", () => {
  test("accepts and formats the public aggregate", () => {
    const report = parseReport(sample)
    expect(metricRows(report)).toEqual([
      ["Sessions analyzed", "2,178"],
      ["Execution calls", "347,214"],
      ["Can run in just-bash", "69.16%"],
      ["Full VM required", "30.84%"],
      ["Median time before agent needs full machine again", "11.5s"],
      ["p95 time before agent needs full machine again", "109.2s"],
    ])
  })

  test("rejects inconsistent or identifying extra data", () => {
    expect(() => parseReport({ ...sample, fullVmPercent: 20 })).toThrow(InvalidReportError)
    expect(() => parseReport({ ...sample, sessionsAnalyzed: -1 })).toThrow(InvalidReportError)
    expect(() => parseReport({ ...sample, repository: "secret/project" })).toThrow("Unexpected report field")
    expect(() => parseReport({ ...sample, workerdPercent: 0 })).toThrow("Unexpected report field")
    expect(formatDuration(null)).toBe("Unavailable")
  })
})
