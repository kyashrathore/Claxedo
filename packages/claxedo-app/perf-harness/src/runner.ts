import { runBrowser } from "./browser-runner"
import type { RunOptions, ScenarioResult } from "./types"

// One adapter: the real browser. There is no deterministic path anymore.
export function run(options: RunOptions): Promise<ScenarioResult[]> {
  return runBrowser(options)
}
