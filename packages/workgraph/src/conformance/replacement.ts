import type { CommandResult } from "../contracts"

export type ReplacementConformanceScenario = "version_drift" | "unrelated_work" | "durable_effect"

export type ReplacementConformanceFactory = (
  scenario: ReplacementConformanceScenario,
) => Promise<CommandResult>

export type ReplacementConformanceCase = Readonly<{
  name: string
  run: () => Promise<void>
}>

export function workGraphReplacementConformance(
  factory: ReplacementConformanceFactory,
): readonly ReplacementConformanceCase[] {
  return [
    testCase("rejects a replacement when a reviewed Task version changes", "version_drift", "version_conflict", factory),
    testCase("rejects a replacement when unrelated nonterminal work enters the Stream", "unrelated_work", "blocked", factory),
    testCase("rejects a replacement after the Stream records a durable external effect", "durable_effect", "close_required", factory),
  ]
}

function testCase(
  name: string,
  scenario: ReplacementConformanceScenario,
  code: string,
  factory: ReplacementConformanceFactory,
): ReplacementConformanceCase {
  return {
    name,
    run: async () => {
      const result = await factory(scenario)
      if (result.ok || result.error.code !== code) {
        throw new Error(`${name}: expected ${code}, received ${result.ok ? "success" : result.error.code}`)
      }
    },
  }
}
