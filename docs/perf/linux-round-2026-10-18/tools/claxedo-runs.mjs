import path from "node:path"
import { pathToFileURL } from "node:url"

const benchmark = process.env.AGENT_APP_BENCHMARK_ROOT ?? "/home/user/kyashrathore/agent-app-benchmark"
const load = (file) => import(pathToFileURL(path.join(benchmark, "src", file)).href)
const { readResultFiles, comparabilityProblems, describeRuns } = await load("compare-results.mjs")
const { buildVerdict, renderVerdict, verdictCells } = await load("verdict.mjs")

const relabel = (entries, label) => entries.map(({ file, result }) => ({ file, result: { ...result, app: { ...result.app, id: label, name: label } } }))

function runHeader(runs, hostConditions) {
  return [
    ...runs.map((run) => `- ${run.app} ${run.scenario}: ${run.createdAt}, driver ${run.driverDigest}, clock rule ${run.clockRule}, conformance ${run.conformance}, 1-minute load ${run.load}`),
    ...hostConditions.flatMap(({ runDirectory, text }) => ["", `Host conditions for ${runDirectory}:`, text]),
  ].join("\n")
}

async function table(runDirectory) {
  const entries = relabel(await readResultFiles([runDirectory]), "claxedo")
  const problems = comparabilityProblems(entries)
  if (problems.length) throw new Error(problems.join("\n"))
  const twin = relabel(entries, "twin")
  const verdict = buildVerdict([...entries, ...twin].map(({ result }) => result), { appIds: ["claxedo", "twin"] })
  const counts = entries.map(({ result }) => {
    const valid = result.observations.filter((observation) => observation.status === "valid").length
    return `- ${result.scenario.id}: ${valid} valid / ${result.observations.length - valid} invalid of ${result.observations.length} observations; resources ${result.resources?.status ?? "n/a"}${result.resources?.reason ? ` (${result.resources.reason})` : ""}`
  })
  const lines = ["| Metric | Median | p95 / max | Min | Valid / attempted |", "|---|---:|---:|---:|---:|"]
  for (const row of verdict.rows) {
    const summary = row.apps.claxedo
    const unit = row.unit === "ms" ? " ms" : row.unit === "MiB" ? " MiB" : " %"
    const fmt = (value) => (value === undefined ? "—" : `${value}${unit}`)
    lines.push(`| ${row.title} | ${fmt(summary.median)} | ${fmt(summary.p95)} / ${fmt(summary.maximum)} | ${fmt(summary.minimum)} | ${summary.valid} / ${summary.attempted} |`)
  }
  const { runs, hostConditions } = await describeRuns(entries)
  return [`# Claxedo run ${runDirectory}`, "", runHeader(runs, hostConditions), "", ...counts, "", ...lines,
    "", "RSS and CPU rows: samples are the framework's 250 ms resource samples inside the idle windows (n counts samples, not runs)."].join("\n")
}

async function verdict(control, candidate) {
  const entries = [...relabel(await readResultFiles([control]), "control"), ...relabel(await readResultFiles([candidate]), "candidate")]
  const problems = comparabilityProblems(entries)
  if (problems.length) throw new Error(`These runs are not comparable:\n${problems.map((problem) => `- ${problem}`).join("\n")}`)
  const result = buildVerdict(entries.map(({ result }) => result), { appIds: ["control", "candidate"] })
  const { runs, hostConditions } = await describeRuns(entries)
  verdictCells(result)
  return [`# Claxedo control ${control} vs candidate ${candidate}`, "", runHeader(runs, hostConditions), "", renderVerdict(result, { control: "control", candidate: "candidate" })].join("\n")
}

const [command, ...args] = process.argv.slice(2)
if (command === "table" && args.length === 1) process.stdout.write(`${await table(path.resolve(args[0]))}\n`)
else if (command === "verdict" && args.length === 2) process.stdout.write(`${await verdict(path.resolve(args[0]), path.resolve(args[1]))}\n`)
else {
  console.error("usage: claxedo-runs.mjs table <run-dir> | verdict <control-run-dir> <candidate-run-dir>")
  process.exit(2)
}
