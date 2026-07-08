import { FLOWS } from "./flows"
import type { ScenarioId } from "./types"

export function option(args: string[], name: string, fallback?: string) {
  const index = args.indexOf(`--${name}`)
  if (index === -1) return fallback
  return args[index + 1] ?? fallback
}

export function flag(args: string[], name: string) {
  return args.includes(`--${name}`)
}

export function scenarioIds(args: string[]): ScenarioId[] {
  const scenario = option(args, "scenario")
  if (scenario) return [scenario as ScenarioId]
  if (flag(args, "all")) return FLOWS.map((flow) => flow.id)
  return ["launch-empty-home"]
}
