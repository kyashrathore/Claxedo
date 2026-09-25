import { join } from "node:path"
import { packageRoot } from "./lib/files"

const checks = [
  "no-comments",
  "size",
  "v2-only",
  "claxedo-names",
  "adapter-boundary",
  "no-swallowed-errors",
  "no-polling",
  "one-home-per-datum",
  "domain-boundaries",
  "one-owner",
  "no-directory-identity",
  "access-boundary",
  "protected-areas",
  "e2e-hygiene",
  "budget",
]
const alwaysShown = new Set(["protected-areas", "budget"])
const width = 4

type Step = { readonly name: string; readonly command: readonly string[] }
type Outcome = { readonly step: Step; readonly code: number; readonly stdout: string; readonly stderr: string; readonly ms: number }

async function main(): Promise<never> {
  const typechecks: Step[] = [
    { name: "typecheck", command: ["bun", "run", "typecheck"] },
    { name: "typecheck checks", command: [join(packageRoot, "node_modules/.bin/tsgo"), "--noEmit", "-p", "scripts/checks/tsconfig.json"] },
    { name: "unit tests", command: ["bun", "test", "src"] },
  ]
  const outcomes: Outcome[] = []
  for (const step of typechecks) outcomes.push(await runStep(step))
  outcomes.push(...(await runPool(checks.map((name) => ({ name, command: ["bun", `scripts/checks/${name}.ts`] })))))
  printOutcomes(outcomes)
  process.exit(outcomes.every((outcome) => outcome.code === 0) ? 0 : 1)
}

async function runPool(steps: readonly Step[]): Promise<Outcome[]> {
  const results: Outcome[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < steps.length) {
      const index = next
      next += 1
      const step = steps[index]
      if (step) results[index] = await runStep(step)
    }
  }
  await Promise.all(Array.from({ length: width }, worker))
  return results
}

async function runStep(step: Step): Promise<Outcome> {
  const started = performance.now()
  const child = Bun.spawn([...step.command], { cwd: packageRoot, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { step, code, stdout, stderr, ms: performance.now() - started }
}

function printOutcomes(outcomes: readonly Outcome[]): void {
  for (const outcome of outcomes) {
    if (outcome.code === 0 && !alwaysShown.has(outcome.step.name)) continue
    console.log(`\n== ${outcome.step.name} ==`)
    process.stdout.write(outcome.stdout)
    process.stdout.write(outcome.stderr)
  }
  console.log(`\n${"step".padEnd(22)} ${"result".padEnd(24)} time`)
  for (const outcome of outcomes) {
    console.log(`${outcome.step.name.padEnd(22)} ${describe(outcome).padEnd(24)} ${(outcome.ms / 1000).toFixed(1)}s`)
  }
  const failed = outcomes.filter((outcome) => outcome.code !== 0).length
  console.log(failed === 0 ? `all ${outcomes.length} steps passed` : `${failed} of ${outcomes.length} steps failed`)
}

function describe(outcome: Outcome): string {
  if (outcome.code === 0) return "pass"
  const lines = outcome.stdout.split("\n").filter(Boolean).length
  return lines > 0 ? `FAIL (${lines} violations)` : `FAIL (exit ${outcome.code})`
}

await main()
