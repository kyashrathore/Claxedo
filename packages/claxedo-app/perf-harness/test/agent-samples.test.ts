import { describe, expect, test } from "bun:test"
import { rawMetricSample, readRawMetricSample, rendererClock } from "../src/agent-samples"

describe("agent-app raw samples", () => {
  test("records the supplied measurement identity, clock, and validity evidence", () => {
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
      attemptId: "attempt-1",
      profile: "workspace-core-v1",
      scenario: "work-item-cold-open-v1",
      metric: "work_item.cold_open_ms",
      observation: { state: "exact", value: 12, unit: "ms" },
      evidence: [{ name: "trusted-click-to-ready-paint", clockOwner: "claxedo-renderer", clockDomain: "performance.now", startTimestamp: 10, endTimestamp: 22 }],
      validity: { status: "valid", evidence: [{ check: "target-visible", expectedCount: 1, actualCount: 1, passed: true }] },
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

describe("agent-app sample readback", () => {
  const sample = (validityEvidence: Array<{ check: string; passed: boolean }>) => rawMetricSample({
    attemptId: "attempt-1",
    profile: "workspace-core-v1",
    scenario: "work-item-cold-open-v1",
    metric: "work_item.cold_open_ms",
    observation: { state: "exact", value: 12, unit: "ms" },
    evidence: [rendererClock({
      name: "trusted-click-to-ready-paint",
      startTimestamp: 10,
      endTimestamp: 22,
      observerMethod: "trusted click through semantic readiness",
    })],
    validityEvidence,
  })
  const roundTrip = (value: unknown) => readRawMetricSample(JSON.parse(JSON.stringify(value)))

  test("reads back a valid sample the driver produced", () => {
    const produced = sample([{ check: "target-visible", passed: true }])
    expect(produced.validity.status).toBe("valid")
    expect(roundTrip(produced)).toEqual(produced)
  })

  test("reads back an invalid sample with its failures", () => {
    const produced = sample([{ check: "target-visible", passed: false }])
    expect(produced.validity.status).toBe("invalid")
    expect(roundTrip(produced)).toEqual(produced)
  })

  test("rejects a sample naming a metric this benchmark does not measure", () => {
    const produced = sample([{ check: "target-visible", passed: true }])
    expect(() => roundTrip({ ...produced, metric: "made.up_metric" })).toThrow("raw metric sample is incomplete")
  })

  test("rejects a sample whose clock evidence lost a timestamp", () => {
    const produced = sample([{ check: "target-visible", passed: true }])
    const [clock] = produced.evidence
    const { endTimestamp: _dropped, ...partial } = clock
    expect(() => roundTrip({ ...produced, evidence: [partial] })).toThrow("clock evidence is missing a required field")
  })

  test("rejects a sample whose observation lost its unit", () => {
    const produced = sample([{ check: "target-visible", passed: true }])
    expect(() => roundTrip({ ...produced, observation: { state: "exact", value: 12 } })).toThrow("exact metric requires value and unit")
  })
})
