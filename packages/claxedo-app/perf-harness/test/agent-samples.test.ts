import { describe, expect, test } from "bun:test"
import { rawMetricSample, rendererClock } from "../src/agent-samples"

describe("agent-app raw samples", () => {
  test("emits a T3 protocol-compatible exact sample", () => {
    expect(rawMetricSample({
      attemptId: "attempt-1",
      profile: "workspace-core-v1",
      scenario: "work-item-cold-open-v1",
      metric: "work_item.cold_open_ms",
      observation: { state: "exact", value: 12, unit: "ms" },
      evidence: [rendererClock({
        name: "trusted-click-to-ready-paint",
        startTimestamp: 10,
        endTimestamp: 22,
        observerMethod: "trusted Playwright click through semantic readiness and two animation frames",
      })],
      validityEvidence: [{ check: "target-visible", expectedCount: 1, actualCount: 1, passed: true }],
    })).toMatchObject({
      schemaVersion: 1,
      sampleId: "attempt-1-work_item.cold_open_ms",
      observation: { state: "exact", value: 12, unit: "ms" },
      validity: { status: "valid" },
    })
  })

  test("an invalid observation cannot claim valid evidence", () => {
    const sample = rawMetricSample({
      attemptId: "attempt-2",
      profile: "terminal-core-v1",
      scenario: "terminal-output-v1",
      metric: "terminal.output_mib_s",
      observation: { state: "invalid", reason: "terminal-model-mismatch" },
      evidence: [rendererClock({
        name: "terminal-output",
        startTimestamp: 1,
        endTimestamp: 2,
        observerMethod: "terminal write observer",
      })],
      validityEvidence: [],
    })
    expect(sample.validity).toMatchObject({
      status: "invalid",
      failures: [{ code: "terminal-model-mismatch" }],
    })
  })
})
