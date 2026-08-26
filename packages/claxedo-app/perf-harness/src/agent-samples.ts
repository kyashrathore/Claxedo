import type { AgentAppProfile, AgentAppScenario } from "./agent-driver-contract"
import type { AgentMetricValue, PrimaryAgentAppMetric } from "./agent-metrics"

export type ClockEvidence = {
  sequence: number
  name: string
  clockOwner: string
  clockDomain: string
  resolutionMs: number
  observerMethod: string
  startTimestamp: number
  endTimestamp: number
}

export type ValidityCheckEvidence = {
  check: string
  expectedSha256?: string
  actualSha256?: string
  expectedCount?: number
  actualCount?: number
  passed: boolean
}

export type RawMetricSample = {
  schemaVersion: 1
  sampleId: string
  attemptId: string
  profile: AgentAppProfile
  scenario: AgentAppScenario
  metric: PrimaryAgentAppMetric
  observation: AgentMetricValue
  evidence: ClockEvidence[]
  validity:
    | { status: "valid"; evidence: ValidityCheckEvidence[] }
    | {
        status: "invalid"
        evidence: ValidityCheckEvidence[]
        failures: Array<{ code: string; message: string; evidence: ValidityCheckEvidence[] }>
      }
}

export function rawMetricSample(input: {
  attemptId: string
  profile: AgentAppProfile
  scenario: AgentAppScenario
  metric: PrimaryAgentAppMetric
  observation: AgentMetricValue
  evidence: ClockEvidence[]
  validityEvidence: ValidityCheckEvidence[]
}): RawMetricSample {
  if (input.evidence.length === 0) throw new Error("raw metric samples require clock evidence")
  assertMonotonicEvidence(input.evidence)
  const failed = input.validityEvidence.filter((item) => !item.passed)
  const observationFailure = input.observation.state === "invalid"
    ? [{ check: input.observation.reason, passed: false }]
    : []
  const failures = [...failed, ...observationFailure]
  return {
    schemaVersion: 1,
    sampleId: `${input.attemptId}-${input.metric}`,
    attemptId: input.attemptId,
    profile: input.profile,
    scenario: input.scenario,
    metric: input.metric,
    observation: input.observation,
    evidence: input.evidence,
    validity: failures.length === 0
      ? { status: "valid", evidence: input.validityEvidence }
      : {
          status: "invalid",
          evidence: [...input.validityEvidence, ...observationFailure],
          failures: failures.map((item) => ({
            code: item.check,
            message: `Claxedo benchmark validity check failed: ${item.check}`,
            evidence: [item],
          })),
        },
  }
}

export function rendererClock(input: {
  sequence?: number
  name: string
  startTimestamp: number
  endTimestamp: number
  observerMethod: string
}): ClockEvidence {
  return {
    sequence: input.sequence ?? 0,
    name: input.name,
    clockOwner: "claxedo-renderer",
    clockDomain: "performance.now",
    resolutionMs: 0.1,
    observerMethod: input.observerMethod,
    startTimestamp: input.startTimestamp,
    endTimestamp: input.endTimestamp,
  }
}

export function driverClock(input: {
  name: string
  startTimestamp: number
  endTimestamp: number
  resolutionMs: number
  observerMethod: string
}): ClockEvidence {
  return {
    sequence: 0,
    name: input.name,
    clockOwner: "claxedo-driver",
    clockDomain: "Bun.performance.now",
    resolutionMs: input.resolutionMs,
    observerMethod: input.observerMethod,
    startTimestamp: input.startTimestamp,
    endTimestamp: input.endTimestamp,
  }
}

function assertMonotonicEvidence(evidence: ClockEvidence[]) {
  let sequence = -1
  const clockEnds = new Map<string, number>()
  for (const item of evidence) {
    if (!Number.isInteger(item.sequence) || item.sequence <= sequence) {
      throw new Error("clock evidence sequence must be strictly increasing")
    }
    if (item.endTimestamp < item.startTimestamp) throw new Error("clock evidence timestamps must be monotonic")
    const clock = `${item.clockOwner}\0${item.clockDomain}`
    const previousEnd = clockEnds.get(clock)
    if (previousEnd !== undefined && item.startTimestamp < previousEnd) {
      throw new Error("clock evidence windows must not overlap within one clock")
    }
    sequence = item.sequence
    clockEnds.set(clock, item.endTimestamp)
  }
}
