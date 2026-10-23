#!/usr/bin/env node
// Times installing the CLI the way packages/cli/README.md tells a person to: npm
// with install scripts off, then the runtime's OpenCode patch step, then the
// command itself. Plain Node with no dependencies, so it runs before anything
// is installed on Windows, macOS and Linux alike.
//
//   node measure-install.mjs --npm <version>     the published CLI
//   node measure-install.mjs --packed <dir>      every *.tgz under <dir>, as the release dry run packed them
//
// It installs into a scratch project rather than the global prefix: the packed
// CLI pins sibling versions npm does not have yet, and a project's `overrides`
// point each one at its tarball. The tree on disk is the global install's.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const [mode, value] = process.argv.slice(2)
if ((mode !== "--npm" && mode !== "--packed") || !value) {
  console.error("usage: node measure-install.mjs --npm <version> | --packed <dir>")
  process.exit(2)
}

const windows = process.platform === "win32"
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cli-install-"))
const project = path.join(scratch, "project")
const cache = path.join(scratch, "npm-cache")
fs.mkdirSync(project)

function run(command, args, options = {}) {
  const startedAt = performance.now()
  // npm and the claxedo bin are .cmd shims on Windows, which only a shell runs.
  const child = spawnSync(command, args, { cwd: project, encoding: "utf8", shell: windows, ...options })
  const ms = Math.round(performance.now() - startedAt)
  if (child.error) throw child.error
  if (child.status !== 0) {
    console.error(`${command} ${args.join(" ")} exited ${child.status}\n${child.stdout}\n${child.stderr}`)
    process.exit(1)
  }
  return { ms, stdout: child.stdout.trim() }
}

function packedManifestName(tarball) {
  const read = spawnSync("tar", ["-xzOf", path.basename(tarball), "package/package.json"], { cwd: path.dirname(tarball), encoding: "utf8" })
  if (read.status !== 0) throw new Error(`cannot read package.json in ${tarball}: ${read.stderr}`)
  return JSON.parse(read.stdout).name
}

function tarballs(dir) {
  return fs.readdirSync(dir, { recursive: true }).filter((entry) => String(entry).endsWith(".tgz")).map((entry) => path.join(dir, String(entry)))
}

function manifest() {
  if (mode === "--npm") return { name: "cli-install-probe", private: true, dependencies: { "@claxedo/cli": value } }
  const packed = Object.fromEntries(tarballs(path.resolve(value)).map((file) => [packedManifestName(file), `file:${file.replaceAll("\\", "/")}`]))
  if (!packed["@claxedo/cli"]) throw new Error(`no @claxedo/cli tarball under ${value}`)
  const { "@claxedo/cli": cli, ...siblings } = packed
  return { name: "cli-install-probe", private: true, dependencies: { "@claxedo/cli": cli }, overrides: siblings }
}

function footprint(dir) {
  let files = 0
  let bytes = 0
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    files += 1
    bytes += fs.lstatSync(path.join(entry.parentPath, entry.name)).size
  }
  return { files, megabytes: Math.round(bytes / 1e6) }
}

/** The phases npm itself timed, from the `--timing` log the last install wrote. */
function npmPhases() {
  const logs = path.join(cache, "_logs")
  const latest = fs.readdirSync(logs).filter((name) => name.endsWith("-timing.json")).sort().at(-1)
  if (!latest) return {}
  const { timers = {} } = JSON.parse(fs.readFileSync(path.join(logs, latest), "utf8"))
  return Object.fromEntries(["npm:load", "idealTree", "reify", "reify:loadTrees", "reify:diffTrees", "reify:retireShallow", "reify:createSparse", "reify:loadBundles", "reify:unpack", "reify:unretire", "reify:build", "reify:save"]
    .filter((name) => typeof timers[name] === "number").map((name) => [name, Math.round(timers[name])]))
}

function defenderRealtime() {
  if (!windows) return undefined
  const read = spawnSync("powershell", ["-NoProfile", "-Command", "(Get-MpComputerStatus).RealTimeProtectionEnabled"], { encoding: "utf8" })
  return read.status === 0 ? read.stdout.trim() : `unknown (${read.stderr.trim().split("\n")[0]})`
}

fs.writeFileSync(path.join(project, "package.json"), JSON.stringify(manifest(), null, 2))
const npm = ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--timing", `--cache=${cache}`]

const cold = run("npm", npm)
const phases = npmPhases()
const tree = footprint(path.join(project, "node_modules"))
fs.rmSync(path.join(project, "node_modules"), { recursive: true, force: true })
fs.rmSync(path.join(project, "package-lock.json"), { force: true })
const warm = run("npm", [...npm, "--prefer-offline"])
const runtime = path.join(project, "node_modules", "@claxedo", "workspace-runtime")
const patch = run(process.execPath, [path.join(runtime, "scripts", "install-opencode-node.mjs")], { shell: false })
const version = run(path.join(project, "node_modules", ".bin", windows ? "claxedo.cmd" : "claxedo"), ["--version"])

const result = {
  source: mode === "--npm" ? `npm @claxedo/cli@${value}` : `packed ${path.basename(path.resolve(value))}`,
  cliVersion: version.stdout,
  os: `${process.platform}-${process.arch}`,
  cpus: os.cpus().length,
  node: process.version,
  npm: run("npm", ["--version"]).stdout,
  defenderRealtime: defenderRealtime(),
  coldInstallMs: cold.ms,
  warmInstallMs: warm.ms,
  patchMs: patch.ms,
  firstRunMs: version.ms,
  ...tree,
  npmPhasesColdMs: phases,
}
console.log(JSON.stringify(result, null, 2))
if (process.env.GITHUB_STEP_SUMMARY) {
  const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    `### CLI install: ${result.source} on ${result.os}`,
    "",
    "| cold install | warm-cache install | patch step | `claxedo --version` | files | size |",
    "|---|---|---|---|---|---|",
    `| ${seconds(cold.ms)} | ${seconds(warm.ms)} | ${seconds(patch.ms)} | ${seconds(version.ms)} | ${tree.files} | ${tree.megabytes} MB |`,
    "",
    `npm's own phases (cold): ${Object.entries(phases).map(([name, ms]) => `${name} ${seconds(ms)}`).join(", ") || "not recorded"}`,
    `${result.cpus} CPUs, Node ${result.node}, npm ${result.npm}${result.defenderRealtime === undefined ? "" : `, Defender real-time protection ${result.defenderRealtime}`}`,
    "",
  ].join("\n"))
}
fs.rmSync(scratch, { recursive: true, force: true })
