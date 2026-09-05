import os from "node:os"

export type HostFingerprint = { hostname: string; platform: string; cpu: string; cores: number; memoryGb: number }

export function hostFingerprint(): HostFingerprint {
  const cpus = os.cpus()
  return {
    hostname: os.hostname(),
    platform: `${process.platform}-${process.arch}`,
    cpu: cpus[0]?.model ?? "unknown",
    cores: cpus.length,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
  }
}

/** The conditions a comparison must hold fixed. Source revision varies separately. */
export type MeasurementContext = {
  version: 1
  suite: "renderer" | "diagnostics" | "attribution" | "memory"
  host: HostFingerprint
  environment: Record<string, string | number>
  workload: string
  instrumentation: string[]
  browserVersion: string
  appMode: string
}

export type MeasurementEvidence = {
  definitionVersion: 2
  method: string
  context: MeasurementContext
}

export function contextKey(context: MeasurementContext) {
  return JSON.stringify({
    version: context.version,
    suite: context.suite,
    workload: context.workload,
    browserVersion: context.browserVersion,
    appMode: context.appMode,
    host: Object.entries(context.host).sort(([a], [b]) => a.localeCompare(b)),
    environment: Object.entries(context.environment).sort(([a], [b]) => a.localeCompare(b)),
    instrumentation: [...context.instrumentation].sort(),
  })
}

export function evidenceMatches(left: MeasurementEvidence | undefined, right: MeasurementEvidence | undefined) {
  return !!left && !!right && left.definitionVersion === right.definitionVersion
    && left.method === right.method && contextKey(left.context) === contextKey(right.context)
}
