import os from "node:os"
import { isRecord, numberField, recordField, textField } from "./json-fields"

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

/**
 * Read stored measurement evidence.
 *
 * Lives here, with the types it produces, so a stored baseline does not have to
 * assert its way back into them. Anything that does not match reads as absent —
 * a comparison with unreadable provenance is not a comparison.
 */
export function parseMeasurementEvidence(value: unknown): MeasurementEvidence | undefined {
  if (!isRecord(value) || value.definitionVersion !== 2) return undefined
  const method = textField(value, "method")
  const context = parseMeasurementContext(recordField(value, "context"))
  if (method === undefined || !context) return undefined
  return { definitionVersion: 2, method, context }
}

const MEASUREMENT_SUITES = ["renderer", "diagnostics", "attribution", "memory"] as const

function parseMeasurementContext(value: Record<string, unknown> | undefined): MeasurementContext | undefined {
  if (!value || value.version !== 1) return undefined
  const suite = MEASUREMENT_SUITES.find((candidate) => candidate === value.suite)
  const host = parseHostFingerprint(recordField(value, "host"))
  const workload = textField(value, "workload")
  const browserVersion = textField(value, "browserVersion")
  const appMode = textField(value, "appMode")
  const environment = recordField(value, "environment")
  const instrumentation = value.instrumentation
  if (
    !suite ||
    !host ||
    workload === undefined ||
    browserVersion === undefined ||
    appMode === undefined ||
    !environment ||
    !Array.isArray(instrumentation)
  ) {
    return undefined
  }
  return {
    version: 1,
    suite,
    host,
    environment: Object.fromEntries(
      Object.entries(environment).flatMap(([name, item]) =>
        typeof item === "string" || typeof item === "number" ? [[name, item]] : [],
      ),
    ),
    workload,
    instrumentation: instrumentation.filter((entry) => typeof entry === "string"),
    browserVersion,
    appMode,
  }
}

function parseHostFingerprint(value: Record<string, unknown> | undefined): HostFingerprint | undefined {
  if (!value) return undefined
  const hostname = textField(value, "hostname")
  const platform = textField(value, "platform")
  const cpu = textField(value, "cpu")
  const cores = numberField(value, "cores")
  const memoryGb = numberField(value, "memoryGb")
  if (
    hostname === undefined ||
    platform === undefined ||
    cpu === undefined ||
    cores === undefined ||
    memoryGb === undefined
  ) {
    return undefined
  }
  return { hostname, platform, cpu, cores, memoryGb }
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
