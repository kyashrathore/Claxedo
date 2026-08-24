#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import path from "node:path"

const BASE_REF = "refs/tags/solid2-native-benchmark-v3-base"
const SOLID1_COMMIT = "d631aad47c16f4d33e1dc64c3dfd3c5abbe3014b"
const FRAMEWORK_COMMIT = "6fa5fbe85fe7cd94b2f35c969af4193aa63687fb"
const CONTROL_ID = "claxedo-solid1-web"
const CANDIDATE_ID = "claxedo-solid2-web"
const START_SCENARIO = "app-start-v3"
const SWITCH_SCENARIO = "session-switch-v3"

const candidateRoot = path.resolve(process.cwd())
const frameworkRoot = path.resolve(
  process.env.AGENT_APP_BENCHMARK_ROOT ?? "/Users/yashvardhansingh/test/agent-app-benchmark",
)
const controlRoot = path.resolve(
  process.env.SOLID1_CONTROL_ROOT ?? "/private/tmp/claxedo-solid1-benchmark-20260824",
)

type Json = Record<string, any>

async function command(
  cmd: string[],
  options: { cwd?: string; env?: Record<string, string>; allowFailure?: boolean } = {},
) {
  const process = Bun.spawn({
    cmd,
    cwd: options.cwd ?? candidateRoot,
    env: { ...Bun.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(`${cmd.join(" ")} failed (${exitCode})\n${stdout}\n${stderr}`)
  }
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
}

async function gitOutput(root: string, args: string[]) {
  return (await command(["git", ...args], { cwd: root })).stdout
}

async function exists(file: string) {
  return Bun.file(file).exists()
}

async function filesUnder(root: string): Promise<string[]> {
  const output: string[] = []
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) output.push(file)
    }
  }
  await visit(root)
  return output.sort()
}

async function hashTree(root: string) {
  const digest = createHash("sha256")
  for (const file of await filesUnder(root)) {
    digest.update(path.relative(root, file))
    digest.update("\0")
    digest.update(Buffer.from(await Bun.file(file).arrayBuffer()))
    digest.update("\0")
  }
  return digest.digest("hex")
}

async function candidateBaseCommit() {
  return gitOutput(candidateRoot, ["rev-parse", "--verify", `${BASE_REF}^{commit}`])
}

async function changedCandidateFiles(baseCommit: string) {
  const tracked = (await gitOutput(candidateRoot, ["diff", "--name-only", baseCommit, "--"]))
    .split("\n")
    .filter(Boolean)
  const untracked = (await gitOutput(candidateRoot, ["ls-files", "--others", "--exclude-standard"]))
    .split("\n")
    .filter(Boolean)
  return [...new Set([...tracked, ...untracked])].sort()
}

function candidateScopeValid(files: string[]) {
  const allowed = [
    "packages/claxedo-app/src/app/",
    "packages/claxedo-app/src/features/session/",
    "packages/claxedo-app/src/lib/",
    "packages/session-ui/src/",
    "packages/ui/src/",
  ]
  const forbidden = new Set([
    "packages/claxedo-app/src/platform/runtime/session-switch.ts",
  ])
  return files.every(
    (file) =>
      allowed.some((prefix) => file.startsWith(prefix)) &&
      !forbidden.has(file) &&
      !/\.(?:css|scss|sass|less)$/u.test(file),
  )
}

async function bootstrapCandidateBuild() {
  if (process.env.CE_OPTIMIZE_SKIP_BUILD === "1") return
  const frozenArtifactsRoot = path.resolve(
    process.env.CLAXEDO_FROZEN_ARTIFACT_ROOT ?? "/private/tmp/claxedo-solid2-benchmark-20260824",
  )
  const immutableArtifacts = [
    "packages/agent-event-runtime/dist",
    "packages/agent-sdk-runtime/dist",
    "packages/claxedo-desktop/resources/claxedo-server",
    "packages/opencode/dist/node",
  ]
  for (const relative of immutableArtifacts) {
    const destination = path.join(candidateRoot, relative)
    if (await exists(destination)) continue
    const source = path.join(frozenArtifactsRoot, relative)
    if (!(await exists(source))) throw new Error(`Missing frozen build input: ${source}`)
    await mkdir(path.dirname(destination), { recursive: true })
    await command(["cp", "-R", source, destination])
  }
  await command(["bun", "run", "build:local"], {
    cwd: path.join(candidateRoot, "packages/claxedo-app"),
  })
}

async function runComparison() {
  await bootstrapCandidateBuild()
  const runsRoot = path.join(
    candidateRoot,
    ".context/compound-engineering/ce-optimize/solid2-beat-solid1-v3/runs",
  )
  await mkdir(runsRoot, { recursive: true })
  const id = `solid2-native-${Date.now()}-${randomUUID().slice(0, 8)}`
  const outputRoot = path.join(runsRoot, id)
  const configFile = path.join(runsRoot, `${id}.config.json`)
  const bunExecutable = process.execPath
  const serverPort = process.env.CLAXEDO_BENCHMARK_WEB_SERVER_PORT ?? "41593"
  const previewPort = process.env.CLAXEDO_BENCHMARK_WEB_PREVIEW_PORT ?? "41444"
  const repetitions = Number(process.env.CE_OPTIMIZE_BENCHMARK_REPETITIONS ?? "2")
  const commonEnv = {
    CLAXEDO_BENCHMARK_TARGET: "web",
    CLAXEDO_BENCHMARK_WEB_SERVER_PORT: serverPort,
    CLAXEDO_BENCHMARK_WEB_PREVIEW_PORT: previewPort,
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH
      ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
      : {}),
  }
  const config = {
    id,
    title: "Claxedo Solid 1 control vs Solid 2 native candidate",
    description: "Paired production-web Chromium/CDP optimization measurement.",
    provenance: "community-self-attested",
    frameworkRevision: FRAMEWORK_COMMIT,
    runProfile: "quick",
    repetitions,
    scenarioIds: [START_SCENARIO, SWITCH_SCENARIO],
    resourceMonitor: path.join(frameworkRoot, "native/resource-monitor/target/release/agent-app-resource-monitor"),
    corpusDirectory: path.join(frameworkRoot, "artifacts/corpora/opencode-completed-sessions-v3"),
    outputRoot,
    apps: [
      {
        id: CONTROL_ID,
        driver: bunExecutable,
        args: [path.join(controlRoot, "packages/claxedo-app/perf-harness/src/public-agent-app-driver.ts")],
        cwd: controlRoot,
        env: {
          ...commonEnv,
          CLAXEDO_BENCHMARK_APP_ID: CONTROL_ID,
          CLAXEDO_BENCHMARK_APP_NAME: "Claxedo Solid 1 Web",
        },
      },
      {
        id: CANDIDATE_ID,
        driver: bunExecutable,
        args: [path.join(candidateRoot, "packages/claxedo-app/perf-harness/src/public-agent-app-driver.ts")],
        cwd: candidateRoot,
        env: {
          ...commonEnv,
          CLAXEDO_BENCHMARK_APP_ID: CANDIDATE_ID,
          CLAXEDO_BENCHMARK_APP_NAME: "Claxedo Solid 2 Web",
        },
      },
    ],
  }
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  const result = await command(
    ["node", "bin/agent-app-benchmark.mjs", "comparison", "run", "--config", configFile],
    { cwd: frameworkRoot },
  )
  await writeFile(
    path.join(outputRoot, "measurement-command.log"),
    `${result.stdout}\n${result.stderr}\n`,
    { mode: 0o600 },
  )
  return outputRoot
}

function average(values: number[]) {
  return values.reduce((total, value) => total + value, 0) / values.length
}

function ratio(candidate: number, control: number) {
  if (!Number.isFinite(candidate) || !Number.isFinite(control) || control <= 0) {
    throw new Error(`Invalid ratio operands: ${candidate} / ${control}`)
  }
  return candidate / control
}

function resultBy(loaded: Json, appId: string, scenarioId: string) {
  const item = loaded.results.find(
    (entry: Json) => entry.result.app.id === appId && entry.result.scenario.id === scenarioId,
  )
  if (!item) throw new Error(`Missing ${appId}/${scenarioId}`)
  return item.result
}

function exactObservations(result: Json, expected: number) {
  return result.observations.length === expected
}

function observationValid(observation: Json) {
  return (
    observation.status === "valid" &&
    Array.isArray(observation.readiness?.checks) &&
    observation.readiness.checks.length > 0 &&
    observation.readiness.checks.every((check: Json) => check.passed === true)
  )
}

async function deriveMetrics(comparisonRoot: string) {
  const comparisonFile = path.join(comparisonRoot, "comparison.json")
  const comparisonModule = await import(
    pathToFileURL(path.join(frameworkRoot, "src/comparison.mjs")).href
  )
  const loaded = await comparisonModule.loadComparison(comparisonFile)
  const controlStart = resultBy(loaded, CONTROL_ID, START_SCENARIO)
  const controlSwitch = resultBy(loaded, CONTROL_ID, SWITCH_SCENARIO)
  const candidateStart = resultBy(loaded, CANDIDATE_ID, START_SCENARIO)
  const candidateSwitch = resultBy(loaded, CANDIDATE_ID, SWITCH_SCENARIO)

  const start = (result: Json, mode: string) => result.derivation.summary[mode].average as number
  const lane = (result: Json, name: string, field: "average" | "p95") =>
    result.derivation.summary[name][field] as number
  const size = (result: Json, bytes: number) => {
    const row = result.derivation.summary.transcriptSizeTrend.find(
      (entry: Json) => entry.transcriptBytes === bytes,
    )
    if (!row) throw new Error(`Missing transcript-size row ${bytes}`)
    return row.average as number
  }
  const resource = (result: Json, field: string) => result.resources[field] as number

  const pairs: Array<[string, number, number]> = [
    ["first_launch_ratio", start(candidateStart, "new-application-state"), start(controlStart, "new-application-state")],
    ["repeat_launch_ratio", start(candidateStart, "initialized-application-state"), start(controlStart, "initialized-application-state")],
    ["within_workspace_warm_avg_ratio", lane(candidateSwitch, "within-workspace-warm", "average"), lane(controlSwitch, "within-workspace-warm", "average")],
    ["within_workspace_cold_avg_ratio", lane(candidateSwitch, "within-workspace-cold", "average"), lane(controlSwitch, "within-workspace-cold", "average")],
    ["across_workspaces_warm_avg_ratio", lane(candidateSwitch, "across-workspaces-warm", "average"), lane(controlSwitch, "across-workspaces-warm", "average")],
    ["across_workspaces_cold_avg_ratio", lane(candidateSwitch, "across-workspaces-cold", "average"), lane(controlSwitch, "across-workspaces-cold", "average")],
    ["size_1mib_avg_ratio", size(candidateSwitch, 1_048_576), size(controlSwitch, 1_048_576)],
    ["size_8mib_avg_ratio", size(candidateSwitch, 8_388_608), size(controlSwitch, 8_388_608)],
    ["size_32mib_avg_ratio", size(candidateSwitch, 33_554_432), size(controlSwitch, 33_554_432)],
    ["size_128mib_avg_ratio", size(candidateSwitch, 134_217_728), size(controlSwitch, 134_217_728)],
    ["baseline_idle_rss_ratio", resource(candidateSwitch, "baselineIdleAverageRssMiB"), resource(controlSwitch, "baselineIdleAverageRssMiB")],
    ["active_average_rss_ratio", resource(candidateSwitch, "activeAverageRssMiB"), resource(controlSwitch, "activeAverageRssMiB")],
    ["active_maximum_rss_ratio", resource(candidateSwitch, "activeMaximumRssMiB"), resource(controlSwitch, "activeMaximumRssMiB")],
    ["active_p95_rss_ratio", resource(candidateSwitch, "activeP95RssMiB"), resource(controlSwitch, "activeP95RssMiB")],
    ["ending_idle_rss_ratio", resource(candidateSwitch, "endingIdleAverageRssMiB"), resource(controlSwitch, "endingIdleAverageRssMiB")],
    ["retained_rss_growth_ratio", resource(candidateSwitch, "retainedRssGrowthMiB"), resource(controlSwitch, "retainedRssGrowthMiB")],
    ["within_workspace_warm_p95_ratio", lane(candidateSwitch, "within-workspace-warm", "p95"), lane(controlSwitch, "within-workspace-warm", "p95")],
    ["within_workspace_cold_p95_ratio", lane(candidateSwitch, "within-workspace-cold", "p95"), lane(controlSwitch, "within-workspace-cold", "p95")],
    ["across_workspaces_warm_p95_ratio", lane(candidateSwitch, "across-workspaces-warm", "p95"), lane(controlSwitch, "across-workspaces-warm", "p95")],
    ["across_workspaces_cold_p95_ratio", lane(candidateSwitch, "across-workspaces-cold", "p95"), lane(controlSwitch, "across-workspaces-cold", "p95")],
  ]
  const ratios = Object.fromEntries(pairs.map(([name, candidate, control]) => [name, ratio(candidate, control)]))
  const ratioValues = Object.values(ratios) as number[]
  const candidateSwitchDurations = candidateSwitch.observations.map((item: Json) => item.durationMs as number)
  const controlSwitchDurations = controlSwitch.observations.map((item: Json) => item.durationMs as number)

  const baseCommit = await candidateBaseCommit()
  const changedFiles = await changedCandidateFiles(baseCommit)
  const candidateHarness = path.join(candidateRoot, "packages/claxedo-app/perf-harness/src")
  const controlHarness = path.join(controlRoot, "packages/claxedo-app/perf-harness/src")
  const [candidateHarnessHash, controlHarnessHash, candidateHead, controlHead, frameworkHead] = await Promise.all([
    hashTree(candidateHarness),
    hashTree(controlHarness),
    gitOutput(candidateRoot, ["rev-parse", "HEAD"]),
    gitOutput(controlRoot, ["rev-parse", "HEAD"]),
    gitOutput(frameworkRoot, ["rev-parse", "HEAD"]),
  ])
  const immutableDiff = await command(
    [
      "git", "diff", "--quiet", baseCommit, "--",
      "packages/claxedo-app/perf-harness/",
      "packages/claxedo-app/src/platform/runtime/session-switch.ts",
      "packages/claxedo-app/package.json",
      "packages/session-ui/package.json",
      "packages/ui/package.json",
      "package.json",
      "bun.lock",
      "patches/",
    ],
    { cwd: candidateRoot, allowFailure: true },
  )
  const baseIsAncestor = await command(
    ["git", "merge-base", "--is-ancestor", baseCommit, "HEAD"],
    { cwd: candidateRoot, allowFailure: true },
  )
  const packageJson = JSON.parse(await readFile(path.join(candidateRoot, "packages/claxedo-app/package.json"), "utf8"))
  const results = [controlStart, controlSwitch, candidateStart, candidateSwitch]
  const observationsComplete =
    exactObservations(controlStart, 4) &&
    exactObservations(candidateStart, 4) &&
    exactObservations(controlSwitch, 106) &&
    exactObservations(candidateSwitch, 106)
  const allObservationsValid = results.every((result) => result.observations.every(observationValid))
  const compatibilityValid = Object.values(loaded.compatibility).every(
    (entry: any) => entry.status === "valid",
  )
  const identityValid = [CONTROL_ID, CANDIDATE_ID].every((appId) => {
    const appStart = resultBy(loaded, appId, START_SCENARIO)
    const appSwitch = resultBy(loaded, appId, SWITCH_SCENARIO)
    return (
      appStart.app.buildDigestSha256 === appSwitch.app.buildDigestSha256 &&
      appStart.driver.digestSha256 === appSwitch.driver.digestSha256 &&
      appStart.driver.sourceCommit === appSwitch.driver.sourceCommit
    )
  })
  const isolatedHost =
    process.env.CE_OPTIMIZE_EXCLUSIVE_HOST === "1" &&
    results.every((result) => result.environment.loadAverage1mPerCpu <= 0.5) &&
    results.every((result) => result.environment.powerSource !== "battery")

  return {
    comparison_valid: compatibilityValid ? 1 : 0,
    observations_complete: observationsComplete ? 1 : 0,
    all_observations_valid: allObservationsValid ? 1 : 0,
    resource_traces_valid:
      controlSwitch.resources?.status === "valid" && candidateSwitch.resources?.status === "valid" ? 1 : 0,
    identities_match: identityValid ? 1 : 0,
    control_frozen:
      controlHead === SOLID1_COMMIT && candidateHarnessHash === controlHarnessHash ? 1 : 0,
    harness_unchanged:
      immutableDiff.exitCode === 0 && frameworkHead === FRAMEWORK_COMMIT && candidateHarnessHash === controlHarnessHash ? 1 : 0,
    app_logic_scope_valid:
      baseIsAncestor.exitCode === 0 && candidateScopeValid(changedFiles) ? 1 : 0,
    solid2_runtime_frozen:
      immutableDiff.exitCode === 0 &&
      packageJson.dependencies?.["solid-js"] === "2.0.0-rc.1" &&
      packageJson.peerDependencies?.["solid-js"] === "2.0.0-rc.1"
        ? 1
        : 0,
    isolated_host_valid: isolatedHost ? 1 : 0,
    worst_solid1_ratio: Math.max(...ratioValues),
    solid1_rows_lost: ratioValues.filter((value) => value >= 1).length,
    switches_over_1000ms: candidateSwitchDurations.filter((value) => value > 1_000).length,
    ...ratios,
    candidate_first_launch_ms: start(candidateStart, "new-application-state"),
    control_first_launch_ms: start(controlStart, "new-application-state"),
    candidate_repeat_launch_ms: start(candidateStart, "initialized-application-state"),
    control_repeat_launch_ms: start(controlStart, "initialized-application-state"),
    candidate_within_warm_p95_ms: lane(candidateSwitch, "within-workspace-warm", "p95"),
    control_within_warm_p95_ms: lane(controlSwitch, "within-workspace-warm", "p95"),
    candidate_within_cold_p95_ms: lane(candidateSwitch, "within-workspace-cold", "p95"),
    control_within_cold_p95_ms: lane(controlSwitch, "within-workspace-cold", "p95"),
    candidate_across_warm_p95_ms: lane(candidateSwitch, "across-workspaces-warm", "p95"),
    control_across_warm_p95_ms: lane(controlSwitch, "across-workspaces-warm", "p95"),
    candidate_across_cold_p95_ms: lane(candidateSwitch, "across-workspaces-cold", "p95"),
    control_across_cold_p95_ms: lane(controlSwitch, "across-workspaces-cold", "p95"),
    candidate_switch_max_ms: Math.max(...candidateSwitchDurations),
    control_switch_max_ms: Math.max(...controlSwitchDurations),
    candidate_baseline_rss_mib: resource(candidateSwitch, "baselineIdleAverageRssMiB"),
    control_baseline_rss_mib: resource(controlSwitch, "baselineIdleAverageRssMiB"),
    candidate_retained_rss_growth_mib: resource(candidateSwitch, "retainedRssGrowthMiB"),
    control_retained_rss_growth_mib: resource(controlSwitch, "retainedRssGrowthMiB"),
    candidate_head_matches_results:
      candidateStart.driver.sourceCommit === candidateHead && candidateSwitch.driver.sourceCommit === candidateHead ? 1 : 0,
    comparison_root: comparisonRoot,
  }
}

const comparisonRoot = process.env.CE_OPTIMIZE_COMPARISON_ROOT
  ? path.resolve(process.env.CE_OPTIMIZE_COMPARISON_ROOT)
  : await runComparison()
const metrics = await deriveMetrics(comparisonRoot)
console.log(JSON.stringify(metrics))
