// Runs every recipe in ladder order and reports a pass/skip/fail table.
// This is the cookbook's truthfulness gate: a recipe either completes, or
// SKIPs with a printed reason — a stack trace fails the gate.
//
// RUN: bun run recipes:all
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "../..")

const ladder = [
  { name: "01-hello-agent", runner: "tsx" },
  { name: "02-harness-swap", runner: "tsx" },
  { name: "03-one-event-shape", runner: "tsx" },
  { name: "04-kill-and-resume", runner: "tsx" },
  { name: "05-workspace-host", runner: "tsx" },
  { name: "06-extensions-once", runner: "tsx" },
  { name: "07-sandbox-secrets", runner: "tsx" },
  { name: "08-place-anywhere", runner: "bun" },
] as const

type Outcome = { name: string; status: "pass" | "skip" | "fail"; seconds: number }
const outcomes: Outcome[] = []

for (const recipe of ladder) {
  const file = path.join(here, `${recipe.name}.ts`)
  const command = recipe.runner === "bun" ? ["bun", [file]] : ["npx", ["tsx", file]]
  console.log(`\n############ ${recipe.name} ############`)
  const started = Date.now()
  const result = spawnSync(command[0] as string, command[1] as string[], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 5 * 60_000,
  })
  const seconds = Math.round((Date.now() - started) / 100) / 10
  const stdout = result.stdout ?? ""
  const stderr = result.stderr ?? ""
  process.stdout.write(stdout)
  if (stderr.trim()) process.stderr.write(stderr)
  // A full skip prints no result blocks; a recipe with results but a gated
  // section (e.g. docker image absent) still counts as a pass.
  const skipped = /^SKIP:/m.test(stdout) && !/^--- end ---$/m.test(stdout)
  const status: Outcome["status"] = result.status === 0 ? (skipped ? "skip" : "pass") : "fail"
  outcomes.push({ name: recipe.name, status, seconds })
}

console.log(`\n=== ladder result ===`)
for (const outcome of outcomes) {
  console.log(`${outcome.status.toUpperCase().padEnd(5)} ${outcome.name} (${outcome.seconds}s)`)
}
const failed = outcomes.filter((outcome) => outcome.status === "fail")
if (failed.length > 0) {
  console.error(`\n${failed.length} recipe(s) failed the gate`)
  process.exit(1)
}
