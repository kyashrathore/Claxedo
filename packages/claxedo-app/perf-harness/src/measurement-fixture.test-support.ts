import type { MeasurementContext } from "./measurement-context"

export const context: MeasurementContext = {
  version: 1, suite: "renderer", host: { hostname: "test-host", platform: "test", cpu: "test", cores: 8, memoryGb: 16 },
  environment: { cpuThrottlingRate: 1 }, workload: "fixed", instrumentation: ["renderer-trace"],
  browserVersion: "test", appMode: "serve",
}


export const source = {
  sourceStable: true,
  sourceIdentity: { mode: "crabbox-raw" as const, sourceSha256: "a".repeat(64), rawSyncFingerprint: "b".repeat(64) },
}
