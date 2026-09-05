import { expect, test } from "bun:test"
import { browserContext, configureExecution, executionSuite } from "./execution-profile"
import { option, scenarioIds } from "./cli-options"
import { requireSupportedStack } from "./stacks"
import { gatePairedHeadline } from "./report"
import { buildFrameMetric } from "./frame-sampler"

test("CLI rejects unknown flows, unavailable implementations, and missing values", () => {
  expect(() => scenarioIds(["--scenario", "made-up"])).toThrow("Unknown")
  expect(() => option(["--scenario", "--all"], "scenario")).toThrow("Missing")
  expect(() => requireSupportedStack("solid-2")).toThrow("no driver")
  expect(() => executionSuite("typo")).toThrow("Unknown")
})

test("execution setup makes required evidence explicit and confines perturbing flags", () => {
  const env: NodeJS.ProcessEnv = {}
  expect(configureExecution("renderer", env)).toContain("causal-observers")
  expect(env.CLAXEDO_PERF_CAUSAL).toBe("1")
  expect(() => configureExecution("diagnostics", { CLAXEDO_PERF_HEADROOM: "1" })).toThrow("removed")
  for (const suite of ["renderer", "diagnostics", "attribution", "memory"] as const) {
    expect(() => configureExecution(suite, { CLAXEDO_PERF_SSE_FREE_CONNECTS: "1" })).toThrow("removed")
  }
  expect(() => configureExecution("renderer", { CLAXEDO_PERF_CPU_PROFILE: "1" })).toThrow("attribution")
  expect(configureExecution("attribution", { CLAXEDO_PERF_CPU_PROFILE: "1" })).toContain("CLAXEDO_PERF_CPU_PROFILE=1")
  expect(() => configureExecution("renderer", { CLAXEDO_PERF_CAUSAL: "0" })).toThrow("requires")
})

test("paired acceptance uses the same fixed policy independent of ambient headroom", () => {
  const control = buildFrameMetric("switch", [], [], 10, undefined, [], [5, 10])
  const enabled = buildFrameMetric("switch", [], [], 20, undefined, [], [8, 16])
  const previous = process.env.CLAXEDO_PERF_HEADROOM
  try {
    process.env.CLAXEDO_PERF_HEADROOM = "1.0"
    expect(gatePairedHeadline(control, enabled, { scenario: "session-switch" }).failures.length).toBeGreaterThan(0)
  } finally {
    if (previous === undefined) delete process.env.CLAXEDO_PERF_HEADROOM
    else process.env.CLAXEDO_PERF_HEADROOM = previous
  }
})

test("memory context reports its actual forced-GC instrumentation and rejects absent causal observers", () => {
  const env: NodeJS.ProcessEnv = {}
  expect(configureExecution("memory", env)).toEqual(["forced-gc"])
  expect(env.CLAXEDO_PERF_CAUSAL).toBeUndefined()
  for (const value of ["0", "1"]) {
    expect(() => configureExecution("memory", { CLAXEDO_PERF_CAUSAL: value })).toThrow("unsupported")
  }
})


test("all comparable suites reject stale builds and undisclosed workload instrumentation", () => {
  for (const suite of ["renderer", "diagnostics", "memory"] as const) {
    expect(() => configureExecution(suite, { CLAXEDO_PERF_SKIP_BUILD: "1" })).toThrow("attribution")
    expect(() => configureExecution(suite, { CLAXEDO_PERF_FETCH_STACKS: "1" })).toThrow("attribution")
    expect(() => configureExecution(suite, { CLAXEDO_PERF_REQUIRE_WORKSPACE_DISPOSAL: "0" })).toThrow("attribution")
    expect(() => configureExecution(suite, { CLAXEDO_PERF_SEED_MESSAGES: "1" })).toThrow("attribution")
  }
  const input = { suite: "renderer" as const, profile: "unthrottled", workload: "fixed", browserVersion: "test", instrumentation: [] }
  expect(browserContext({ ...input, headless: true }).environment.headless).not.toEqual(browserContext({ ...input, headless: false }).environment.headless)
})
