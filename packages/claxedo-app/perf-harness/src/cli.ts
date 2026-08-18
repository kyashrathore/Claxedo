import path from "node:path"
import { flag as optionFlag, option as optionValue, scenarioIds } from "./cli-options"
import { DEFAULT_PROFILE_ID } from "./environment-profile"
import { DEFAULT_STACK_ID } from "./stacks"
import { FLOWS } from "./flows"
import { markdownReport } from "./report"
import { run } from "./runner"
import { reportsRoot } from "./storage"
import { app } from "./targets"
import type { ScenarioResult } from "./types"

const args = process.argv.slice(2)
const command = args[0] ?? "run"

function option(name: string, fallback?: string) {
  return optionValue(args, name, fallback)
}

function flag(name: string) {
  return optionFlag(args, name)
}

if (command === "list") {
  for (const flow of FLOWS) console.log(`${flow.id}\t${flow.name}`)
  process.exit(0)
}

if (command === "report") {
  const input = option("input", path.join(reportsRoot, "latest.json"))!
  const report = await Bun.file(path.isAbsolute(input) ? input : path.resolve(input)).json()
  const flows: ScenarioResult[] = report.flows ?? report.scenarios ?? []
  console.log(markdownReport(flows, { debug: flag("debug") }))
  process.exit(0)
}

if (command === "run") {
  const results = await run({
    scenarios: scenarioIds(args),
    profile: option("profile", DEFAULT_PROFILE_ID)!,
    stack: option("stack", DEFAULT_STACK_ID)!,
    accept_baseline: flag("accept-baseline"),
    iterations: Number(option("iterations", "1")),
    output: option("output", "run.json")!,
    update_baseline: flag("update-baseline"),
    append_trend: !flag("no-trend"),
    headless: !flag("headed"),
    debug: flag("debug"),
  })
  console.log(markdownReport(results, { debug: flag("debug") }))
  // warn does not fail the run; only a real regression / dropped-below-60hz does.
  process.exit(results.some((result) => result.status === "fail") ? 1 : 0)
}

throw new Error(`Unknown command: ${command}. Use: run, list, report (target: ${app.label}).`)
