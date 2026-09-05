import path from "node:path"
import { flag as optionFlag, option as optionValue, scenarioIds } from "./cli-options"
import { DEFAULT_PROFILE_ID } from "./environment-profile"
import { DEFAULT_STACK_ID, requireSupportedStack } from "./stacks"
import { FLOWS } from "./flows"
import { markdownReport } from "./report"
import { executionSuite } from "./execution-profile"
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

function numericOption(name: string, fallback: string, minimum: number) {
  const value = Number(option(name, fallback))
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`Invalid --${name}: expected a number >= ${minimum}, received ${String(value)}`)
  }
  return value
}

if (command === "catalog") {
  const { performanceCatalog } = await import("./catalog")
  const entries = await performanceCatalog()
  if (flag("json")) console.log(JSON.stringify(entries, null, 2))
  else for (const entry of entries) console.log(`${entry.id}\t${entry.kind}\tpackages/${entry.owner}\t${entry.entrypoint}\t${entry.purpose}`)
  process.exit(0)
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

if (command === "memory") {
  const { runMemoryLane } = await import("./memory-lane")
  const { parseMemoryInteger } = await import("./memory-runner")
  const mode = option("mode", "normal")
  if (mode !== "normal" && mode !== "rapid") throw new Error(`Invalid memory mode: ${mode}. Use normal or rapid.`)
  const summary = await runMemoryLane({
    profile: option("profile", DEFAULT_PROFILE_ID)!,
    stack: requireSupportedStack(option("stack", DEFAULT_STACK_ID)!),
    sessions: parseMemoryInteger("--sessions", option("sessions", "60"), 2),
    accept_baseline: flag("accept-baseline"),
    headless: !flag("headed"),
    snapshot: flag("snapshot"),
    iterations: parseMemoryInteger("--iterations", option("iterations", "1"), 1),
    mode,
    normalDwellMs: numericOption("normal-dwell-ms", "750", 0),
    rapidDwellMs: numericOption("rapid-dwell-ms", "120", 0),
    cacheCeiling: numericOption("cache-ceiling", "40", 1),
    settleMinimumMs: numericOption("settle-minimum-ms", "2500", 0),
    settleTimeoutMs: numericOption("settle-timeout-ms", "8000", 1_000),
  })
  console.log(summary)
  process.exit(0)
}

if (command === "run") {
  if (flag("update-baseline")) throw new Error("--update-baseline was removed; use --accept-baseline")
  const { runBrowser } = await import("./browser-runner")
  const results = await runBrowser({
    scenarios: scenarioIds(args),
    profile: option("profile", DEFAULT_PROFILE_ID)!,
    stack: requireSupportedStack(option("stack", DEFAULT_STACK_ID)!),
    accept_baseline: flag("accept-baseline"),
    iterations: numericOption("iterations", "1", 1),
    output: option("output", "run.json")!,
    suite: executionSuite(option("suite")),
    append_trend: !flag("no-trend"),
    headless: !flag("headed"),
    debug: flag("debug"),
  })
  console.log(markdownReport(results, { debug: flag("debug") }))
  // warn does not fail the run; only a real regression / dropped-below-60hz does.
  process.exit(results.some((result) => result.status === "fail") ? 1 : 0)
}

throw new Error(`Unknown command: ${command}. Use: run, memory, list, catalog, report (target: ${app.label}).`)
