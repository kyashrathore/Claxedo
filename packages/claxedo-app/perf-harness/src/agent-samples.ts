import { AGENT_APP_PROFILES, AGENT_APP_SCENARIOS, type AgentAppProfile, type AgentAppScenario } from "./agent-driver-contract"
import { PRIMARY_AGENT_APP_METRICS, readAgentMetricValue, type AgentMetricValue, type PrimaryAgentAppMetric } from "./agent-metrics"
import { isRecord, numberField, recordField, recordsField, textField } from "./json-fields"

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
  /** Which verification the check applied (e.g. text-part-sha256 vs part-identity). */
  mode?: string
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

/**
 * Read a sample that came back across the driver's JSON boundary.
 *
 * The inverse of `rawMetricSample` above, which is the only thing that produces
 * these records. The vocabulary fields are checked against the same lists the
 * request decoder uses, so a sample naming an unknown metric is rejected here
 * rather than reaching a report and a baseline comparison.
 */
export function readRawMetricSample(value: unknown): RawMetricSample {
  if (!isRecord(value)) throw new Error("raw metric sample must be an object")
  const sampleId = textField(value, "sampleId")
  const attemptId = textField(value, "attemptId")
  const profile = AGENT_APP_PROFILES.find((entry) => entry === value.profile)
  const scenario = AGENT_APP_SCENARIOS.find((entry) => entry === value.scenario)
  const metric = PRIMARY_AGENT_APP_METRICS.find((entry) => entry === value.metric)
  const evidence = recordsField(value, "evidence")
  if (
    value.schemaVersion !== 1 || sampleId === undefined || attemptId === undefined ||
    !profile || !scenario || !metric || !evidence
  ) {
    throw new Error(`raw metric sample is incomplete: ${JSON.stringify(value.sampleId)}`)
  }
  return {
    schemaVersion: 1,
    sampleId,
    attemptId,
    profile,
    scenario,
    metric,
    observation: readAgentMetricValue(value.observation),
    evidence: evidence.map(readClockEvidence),
    validity: readValidity(recordField(value, "validity")),
  }
}

function readClockEvidence(value: Record<string, unknown>): ClockEvidence {
  const sequence = numberField(value, "sequence")
  const name = textField(value, "name")
  const clockOwner = textField(value, "clockOwner")
  const clockDomain = textField(value, "clockDomain")
  const resolutionMs = numberField(value, "resolutionMs")
  const observerMethod = textField(value, "observerMethod")
  const startTimestamp = numberField(value, "startTimestamp")
  const endTimestamp = numberField(value, "endTimestamp")
  if (
    sequence === undefined || name === undefined || clockOwner === undefined || clockDomain === undefined ||
    resolutionMs === undefined || observerMethod === undefined ||
    startTimestamp === undefined || endTimestamp === undefined
  ) {
    throw new Error("clock evidence is missing a required field")
  }
  return { sequence, name, clockOwner, clockDomain, resolutionMs, observerMethod, startTimestamp, endTimestamp }
}

function readValidityCheckEvidence(value: Record<string, unknown>): ValidityCheckEvidence {
  const check = textField(value, "check")
  if (check === undefined || typeof value.passed !== "boolean") {
    throw new Error("validity evidence requires a check and a verdict")
  }
  const mode = textField(value, "mode")
  const expectedSha256 = textField(value, "expectedSha256")
  const actualSha256 = textField(value, "actualSha256")
  const expectedCount = numberField(value, "expectedCount")
  const actualCount = numberField(value, "actualCount")
  return {
    check,
    passed: value.passed,
    ...(mode === undefined ? {} : { mode }),
    ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
    ...(actualSha256 === undefined ? {} : { actualSha256 }),
    ...(expectedCount === undefined ? {} : { expectedCount }),
    ...(actualCount === undefined ? {} : { actualCount }),
  }
}

function readValidity(value: Record<string, unknown> | undefined): RawMetricSample["validity"] {
  const evidence = value && recordsField(value, "evidence")
  if (!value || !evidence) throw new Error("raw metric samples require a validity record")
  if (value.status === "valid") return { status: "valid", evidence: evidence.map(readValidityCheckEvidence) }
  const failures = recordsField(value, "failures")
  if (value.status !== "invalid" || !failures) {
    throw new Error(`unsupported sample validity status: ${JSON.stringify(value.status)}`)
  }
  return {
    status: "invalid",
    evidence: evidence.map(readValidityCheckEvidence),
    failures: failures.map((failure) => {
      const code = textField(failure, "code")
      const message = textField(failure, "message")
      const rows = recordsField(failure, "evidence")
      if (code === undefined || message === undefined || !rows) {
        throw new Error("sample validity failure is missing a required field")
      }
      return { code, message, evidence: rows.map(readValidityCheckEvidence) }
    }),
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
