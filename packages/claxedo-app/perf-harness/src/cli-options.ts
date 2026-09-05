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

export function scenarioIds(args: string[]): ScenarioId[] {
  const scenario = option(args, "scenario")
  if (scenario) {
    if (!FLOWS.some((flow) => flow.id === scenario)) throw new Error(`Unknown --scenario ${scenario}`)
    return [scenario as ScenarioId]
  }
  if (flag(args, "all")) return FLOWS.map((flow) => flow.id)
  return [FLOWS[0].id]
}
