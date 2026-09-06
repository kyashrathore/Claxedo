import { environmentProfile } from "./environment-profile"
import { hostFingerprint, type MeasurementContext } from "./measurement-context"

export const EXECUTION_SUITES = ["renderer", "diagnostics", "attribution"] as const
export type ExecutionSuite = (typeof EXECUTION_SUITES)[number]

export function executionSuite(value = "renderer"): ExecutionSuite {
  const suite = EXECUTION_SUITES.find((candidate) => candidate === value)
  if (!suite) throw new Error(`Unknown --suite ${value}. Use ${EXECUTION_SUITES.join(", ")}`)
  return suite
}

// Required causal observers are part of each suite's fixed measurement setup.
// Optional profiling and workload ablations are confined to attribution runs.
const diagnosticFlags = [
  "CLAXEDO_PERF_CPU_PROFILE", "CLAXEDO_PERF_TRACE", "CLAXEDO_PERF_PER_SWITCH",
  "CLAXEDO_PERF_STYLE_DUMP", "CLAXEDO_PERF_PROFILE_DIR", "CLAXEDO_PERF_RECORD_VIDEO",
  "CLAXEDO_PERF_REQUEST_LOG", "CLAXEDO_PERF_FETCH_STACKS", "CLAXEDO_PERF_DIAGNOSTIC",
  "CLAXEDO_PERF_WARM_SESSION_SWITCH", "CLAXEDO_PERF_SESSION_SWITCH_ROUNDS",
  "CLAXEDO_PERF_SESSION_PREFETCH_SETTLE_MS", "CLAXEDO_PERF_SESSION_RENDERER",
  "CLAXEDO_PERF_MERMAID_EXPLICIT",
  "CLAXEDO_PERF_SKIP_BUILD", "CLAXEDO_PERF_REQUIRE_WORKSPACE_DISPOSAL",
  "CLAXEDO_PERF_DEBUG_SESSION_SWITCH",
] as const

export function rejectRemovedExecutionOptions(env: NodeJS.ProcessEnv = process.env) {
  if (env.CLAXEDO_PERF_HEADROOM !== undefined) {
    throw new Error("CLAXEDO_PERF_HEADROOM was removed; diagnostics uses the reviewed 10% paired gate")
  }
  if (env.CLAXEDO_PERF_SSE_FREE_CONNECTS !== undefined) {
    throw new Error("CLAXEDO_PERF_SSE_FREE_CONNECTS was removed; fixture SSE connections now remain open until their owner closes them")
  }
}

export function configureExecution(suite: ExecutionSuite | "memory", env: NodeJS.ProcessEnv = process.env) {
  rejectRemovedExecutionOptions(env)
  const active = Object.keys(env).filter((name) => env[name] !== undefined && (diagnosticFlags.some((flag) => flag === name) || (name.startsWith("CLAXEDO_PERF_") && !["CLAXEDO_PERF_CAUSAL", "CLAXEDO_PERF_MOCK_PORT", "CLAXEDO_PERF_APP_SCRIPT"].includes(name))))
  if (suite !== "attribution" && active.length) {
    throw new Error(`Use --suite attribution for profiling or workload overrides: ${active.join(", ")}`)
  }
  if (suite !== "attribution" && env.CLAXEDO_PERF_APP_SCRIPT && env.CLAXEDO_PERF_APP_SCRIPT !== "serve") {
    throw new Error("Renderer and diagnostics suites require the production serve build")
  }
  if (suite === "memory") {
    if (env.CLAXEDO_PERF_CAUSAL !== undefined) {
      throw new Error("The memory suite does not install causal observers; CLAXEDO_PERF_CAUSAL is unsupported")
    }
    return ["forced-gc"]
  }
  if (env.CLAXEDO_PERF_CAUSAL !== undefined && env.CLAXEDO_PERF_CAUSAL !== "1") {
    throw new Error("The selected suite requires causal evidence; CLAXEDO_PERF_CAUSAL must be 1")
  }
  env.CLAXEDO_PERF_CAUSAL = "1"
  return ["renderer-trace", "raf-heartbeat", "causal-observers", ...active.map((name) => `${name}=${env[name]}`)]
}

export function browserContext(input: {
  suite: ExecutionSuite; profile: string; workload: unknown; browserVersion: string; instrumentation: string[]; headless: boolean
}): MeasurementContext {
  return {
    version: 1,
    suite: input.suite,
    host: hostFingerprint(),
    environment: { ...environmentProfile(input.profile), headless: String(input.headless),
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[0].startsWith("VITE_") && entry[1] !== undefined)),
    },
    workload: JSON.stringify(input.workload),
    instrumentation: input.instrumentation,
    browserVersion: input.browserVersion,
    appMode: process.env.CLAXEDO_PERF_APP_SCRIPT ?? "serve",
  }
}
