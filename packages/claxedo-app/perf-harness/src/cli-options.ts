import { FLOWS } from "./flows"
import type { ScenarioId } from "./types"

export function option(args: string[], name: string, fallback?: string) {
  const index = args.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`)
  return value
}

export function flag(args: string[], name: string) {
  return args.includes(`--${name}`)
}

/**
 * Read a caller-supplied string as one of a known set.
 *
 * Command-line and environment values arrive as `string`, and the probes and
 * runners that consume them each used to assert the value into their own
 * union. An assertion accepts a typo silently and fails later, somewhere else;
 * matching against the set rejects it here, naming the choices.
 */
export function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], label: string): T {
  const match = allowed.find((candidate) => candidate === value)
  if (match === undefined) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}; got ${value ?? "<unset>"}`)
  }
  return match
}

export function scenarioIds(args: string[]): ScenarioId[] {
  const scenario = option(args, "scenario")
  if (scenario) {
    const flow = FLOWS.find((candidate) => candidate.id === scenario)
    if (!flow) throw new Error(`Unknown --scenario ${scenario}`)
    return [flow.id]
  }
  if (flag(args, "all")) return FLOWS.map((flow) => flow.id)
  return [FLOWS[0].id]
}
