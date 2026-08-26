#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

const root = join(import.meta.dir, "..")
const cbx = join(root, "script", "cbx")
const stateFile = join(root, ".crabbox", "ci", "last-run.json")

const coreShards = Array.from({ length: 12 }, (_, index) => `pr-e2e-core-${String(index + 1).padStart(2, "0")}`)
const awsCoreShards = coreShards.map((job) => `${job}-aws`)
const groups = {
  "pr-linux": [
    "pr-diagnostics-linux-aws",
    "pr-unit-linux-aws",
    "pr-typecheck-linux-aws",
    ...awsCoreShards,
    "pr-e2e-workgraph-linux-aws",
    "pr-e2e-tier-real-linux-aws",
    "pr-e2e-workgraph-journey-linux-aws",
    "pr-agent-runtime-stats-linux-aws",
    "pr-docs-links-linux-aws",
    "pr-packages-dry-run-linux-aws",
    "pr-relay-bench-linux-aws",
    "pr-storybook-linux-aws",
  ],
  "pr-linux-hetzner": [
    "pr-diagnostics-linux",
    "pr-unit-linux",
    "pr-typecheck-linux",
    ...coreShards,
    "pr-e2e-workgraph-linux",
    "pr-e2e-tier-real-linux",
    "pr-e2e-workgraph-journey-linux",
    "pr-agent-runtime-stats-linux",
    "pr-docs-links-linux",
    "pr-packages-dry-run-linux",
    "pr-relay-bench-linux",
    "pr-storybook-linux",
  ],
  "pr-native": [
    "pr-unit-windows",
    "pr-e2e-desktop-macos",
    "pr-agent-runtime-stats-windows",
    "pr-agent-runtime-stats-macos",
  ],
} as const

const focusedJobs = [
  "focus-agent-sdk-runtime-windows",
  "focus-server-core-windows",
  "focus-e2e-tier-real-claude-acp-linux-aws",
  "focus-e2e-tier-real-claude-native-linux-aws",
  "focus-e2e-tier-real-codex-acp-linux-aws",
  "focus-e2e-tier-real-codex-native-linux-aws",
  "focus-e2e-tier-real-cursor-linux-aws",
  "focus-e2e-tier-real-web-linux-aws",
] as const
const allJobs = new Set([...Object.values(groups).flat(), ...focusedJobs])

type RunResult = {
  job: string
  exitCode: number
  startedAt: string
  finishedAt: string
}

type RunState = {
  schema: "claxedo/crabbox-ci-state/v1"
  results: RunResult[]
}

function usage(): never {
  console.error(`usage:
  script/cbx-ci.ts list
  script/cbx-ci.ts dry-run [pr-linux|pr-linux-hetzner|pr-native|pr|job ...]
  script/cbx-ci.ts run [--concurrency N] [--id LEASE] [pr-linux|pr-linux-hetzner|pr-native|pr|job ...]
  script/cbx-ci.ts retry [--concurrency N] [--id LEASE]

Defaults: group=pr-linux, concurrency=12. Passing --id reuses one lease and
forces concurrency=1 so jobs cannot corrupt each other's workspace.`)
  process.exit(2)
}

function expandNames(names: string[]): string[] {
  const requested = names.length === 0 ? ["pr-linux"] : names
  const expanded: string[] = []
  for (const name of requested) {
    if (name === "pr") {
      expanded.push(...groups["pr-linux"], ...groups["pr-native"])
    } else if (name in groups) {
      expanded.push(...groups[name as keyof typeof groups])
    } else if (allJobs.has(name)) {
      expanded.push(name)
    } else {
      throw new Error(`unknown Crabbox CI group or job: ${name}`)
    }
  }
  return [...new Set(expanded)]
}

function parseOptions(args: string[]) {
  let concurrency = 12
  let lease: string | undefined
  const names: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--concurrency") {
      const value = args[++index]
      if (!value || !/^\d+$/.test(value) || Number(value) < 1) {
        throw new Error("--concurrency requires a positive integer")
      }
      concurrency = Number(value)
    } else if (arg === "--id") {
      lease = args[++index]
      if (!lease) throw new Error("--id requires a lease id or slug")
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`)
    } else {
      names.push(arg)
    }
  }
  if (lease) concurrency = 1
  return { concurrency, lease, names }
}

async function runProcess(args: string[]): Promise<number> {
  const child = Bun.spawn(args, {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  return child.exited
}

async function runJob(job: string, options: { dryRun: boolean; lease?: string }): Promise<RunResult> {
  const startedAt = new Date().toISOString()
  console.log(`\n=== Crabbox CI: ${job} ===`)
  const args = [cbx, "job", "run"]
  if (options.dryRun) args.push("--dry-run")
  if (options.lease) args.push("--id", options.lease)
  args.push(job)
  const exitCode = await runProcess(args)
  return { job, exitCode, startedAt, finishedAt: new Date().toISOString() }
}

async function runJobs(jobs: string[], options: { concurrency: number; dryRun: boolean; lease?: string }) {
  const results: RunResult[] = []
  let next = 0
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]
      results.push(await runJob(job, options))
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, jobs.length) }, worker))
  results.sort((a, b) => jobs.indexOf(a.job) - jobs.indexOf(b.job))
  return results
}

async function saveState(results: RunResult[]) {
  const state: RunState = { schema: "claxedo/crabbox-ci-state/v1", results }
  await mkdir(dirname(stateFile), { recursive: true })
  await Bun.write(stateFile, `${JSON.stringify(state, null, 2)}\n`)
}

async function loadFailedJobs(): Promise<string[]> {
  const file = Bun.file(stateFile)
  if (!(await file.exists())) {
    throw new Error(`no previous run state at ${stateFile}`)
  }
  const state = (await file.json()) as RunState
  if (state.schema !== "claxedo/crabbox-ci-state/v1" || !Array.isArray(state.results)) {
    throw new Error(`unsupported Crabbox CI state at ${stateFile}`)
  }
  return state.results.filter((result) => result.exitCode !== 0).map((result) => result.job)
}

function printSummary(results: RunResult[], dryRun: boolean) {
  const failed = results.filter((result) => result.exitCode !== 0)
  console.log(dryRun ? "\nCrabbox CI dry-run summary" : "\nCrabbox CI summary")
  for (const result of results) {
    const status = result.exitCode === 0 ? (dryRun ? "PLAN" : "PASS") : "FAIL"
    console.log(`${status}  ${result.job}`)
  }
  if (!dryRun && failed.length > 0) {
    console.log(`\nRetry only failures with: script/cbx-ci.ts retry`)
  }
  return failed.length === 0 ? 0 : 1
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command) usage()

  if (command === "list") {
    console.log("Groups:")
    console.log(`  pr-linux  ${groups["pr-linux"].length} jobs`)
    console.log(`  pr-linux-hetzner ${groups["pr-linux-hetzner"].length} jobs`)
    console.log(`  pr-native ${groups["pr-native"].length} jobs`)
    console.log(`  pr        ${allJobs.size} jobs`)
    console.log("\nConfigured jobs:")
    process.exit(await runProcess([cbx, "job", "list"]))
  }

  const options = parseOptions(args)
  let jobs: string[]
  if (command === "retry") {
    if (options.names.length > 0) throw new Error("retry does not accept job names")
    jobs = await loadFailedJobs()
    if (jobs.length === 0) {
      console.log("The previous Crabbox CI run has no failed jobs.")
      return
    }
  } else if (command === "run" || command === "dry-run") {
    jobs = expandNames(options.names)
  } else {
    usage()
  }

  const dryRun = command === "dry-run"
  // A trusted static Mac is a durable host, not an isolated lease per job.
  // Never run two macOS jobs against its synced worktree concurrently. Linux
  // and managed Windows jobs retain the requested parallelism.
  const macJobs = jobs.filter((job) => job.endsWith("-macos"))
  const isolatedJobs = jobs.filter((job) => !job.endsWith("-macos"))
  const results = [
    ...(await runJobs(isolatedJobs, { ...options, dryRun })),
    ...(await runJobs(macJobs, { ...options, concurrency: 1, dryRun })),
  ].sort((a, b) => jobs.indexOf(a.job) - jobs.indexOf(b.job))
  if (!dryRun) await saveState(results)
  process.exit(printSummary(results, dryRun))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(2)
})
