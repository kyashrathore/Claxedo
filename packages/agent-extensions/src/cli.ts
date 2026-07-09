import fs from "fs/promises"
import os from "os"
import path from "path"
import { cachePackageRoot } from "./cache"
import { createAgentExtensions, parseHarnessTargets } from "./facade"
import {
  discoverAgentExtensionComponents,
} from "./discovery"
import {
  materializedRecordPath,
  readMaterializedRuntimeRecord,
} from "./materialization"
import { applyRuntimeAgentExtensions } from "./replay"
import { getRuntimeAgentExtensionsSnapshot, type RuntimeAgentExtensionsSnapshot } from "./runtime-config"
import {
  allHarnessTargets,
  FIRST_PARTY_AGENT_EXTENSION_ID,
  FIRST_PARTY_AGENT_EXTENSIONS_DIR,
  type HarnessTarget,
} from "./types"

type CliIO = {
  cwd?: string
  homeDir?: string
  now?: number | (() => number)
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

type ResolvedCliIO = {
  cwd: string
  homeDir: string
  now?: number | (() => number)
  stdout: (text: string) => void
  stderr: (text: string) => void
}

type Flags = {
  project?: string
  home?: string
  cacheDir?: string
  runtimeDir?: string
  targets?: string
  id?: string
  path?: string
  json?: boolean
  help?: boolean
}

function usage() {
  return [
    "Usage:",
    "  agent-extensions install <github-source> [--project <dir>] [--targets <list>] [--id <id>] [--json]",
    "  agent-extensions install --path <package-dir> [--project <dir>] [--targets <list>] [--id <id>] [--json]",
    "  agent-extensions update <id> [--project <dir>] [--json]",
    "  agent-extensions enable <id> [--project <dir>] [--json]",
    "  agent-extensions disable <id> [--project <dir>] [--json]",
    "  agent-extensions uninstall <id> [--project <dir>] [--json]",
    "  agent-extensions doctor [--project <dir>] [--json]",
    "  agent-extensions materialize [--project <dir>] [--runtime-dir <dir>] [--home <dir>] [--targets <list>] [--json]",
    "  agent-extensions list [--project <dir>] [--runtime-dir <dir>] [--json]",
    "",
    "Options:",
    "  --project    Project directory. Defaults to the current working directory",
    "  --home       Home directory for machine-scoped runner targets. Defaults to the current user home",
    "  --cache-dir  Package cache and durable install state. Defaults to CLAXEDO_DATA_DIR or ~/.claxedo",
    "  --runtime-dir Generated runtime state directory for materialize/list. Defaults to <project>/.agent-extensions",
    "  --targets    Comma-separated targets: opencode, claude, codex, cursor",
    "  --id         Stable install id. Defaults to package name",
    "  --path       Local project package path for install",
    "  --json       Print JSON output",
    "  -h, --help   Show this help",
  ].join("\n")
}

function readFlagValue(argv: string[], index: number, name: string) {
  const value = argv[index + 1]
  if (!value || value.startsWith("-")) throw new Error(`${name} requires a value`)
  return value
}

function parse(argv: string[]) {
  const [command = "help", ...rest] = argv
  const flags: Flags = {}
  const positionals: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (arg === "-h" || arg === "--help") {
      flags.help = true
      continue
    }
    if (arg === "--json") {
      flags.json = true
      continue
    }
    if (arg === "--project") {
      flags.project = readFlagValue(rest, i, arg)
      i++
      continue
    }
    if (arg.startsWith("--project=")) {
      flags.project = arg.slice("--project=".length)
      continue
    }
    if (arg === "--home") {
      flags.home = readFlagValue(rest, i, arg)
      i++
      continue
    }
    if (arg.startsWith("--home=")) {
      flags.home = arg.slice("--home=".length)
      continue
    }
    if (arg === "--cache-dir") {
      flags.cacheDir = readFlagValue(rest, i, arg)
      i++
      continue
    }
    if (arg === "--runtime-dir") {
      flags.runtimeDir = readFlagValue(rest, i, arg)
      i++
      continue
    }
    if (arg.startsWith("--cache-dir=")) {
      flags.cacheDir = arg.slice("--cache-dir=".length)
      continue
    }
    if (arg.startsWith("--runtime-dir=")) {
      flags.runtimeDir = arg.slice("--runtime-dir=".length)
      continue
    }
    if (arg === "--targets" || arg === "--target") {
      flags.targets = readFlagValue(rest, i, arg)
      i++
      continue
    }
    if (arg.startsWith("--targets=")) {
      flags.targets = arg.slice("--targets=".length)
      continue
    }
    if (arg.startsWith("--target=")) {
      flags.targets = arg.slice("--target=".length)
      continue
    }
    if (arg === "--id") {
      flags.id = readFlagValue(rest, i, arg)
      i++
      continue
    }
    if (arg.startsWith("--id=")) {
      flags.id = arg.slice("--id=".length)
      continue
    }
    if (arg === "--path" || arg === "--package-path") {
      flags.path = readFlagValue(rest, i, arg)
      i++
      continue
    }
    if (arg.startsWith("--path=")) {
      flags.path = arg.slice("--path=".length)
      continue
    }
    if (arg.startsWith("--package-path=")) {
      flags.path = arg.slice("--package-path=".length)
      continue
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`)
    positionals.push(arg)
  }
  return { command, flags, positionals }
}

function resolveFrom(cwd: string, input: string | undefined, fallback: string) {
  return path.resolve(cwd, input ?? fallback)
}

function json(output: unknown) {
  return JSON.stringify(output, null, 2)
}

function relative(cwd: string, target: string) {
  const value = path.relative(cwd, target)
  return value || "."
}

function targets(flags: Flags): HarnessTarget[] | undefined {
  return parseHarnessTargets(flags.targets)
}

function client(flags: Flags, io: ResolvedCliIO) {
  const projectDir = resolveFrom(io.cwd, flags.project, ".")
  return createAgentExtensions({
    projectDir,
    homeDir: resolveFrom(io.cwd, flags.home, io.homeDir),
    dataRoot: resolveFrom(io.cwd, flags.cacheDir, process.env.CLAXEDO_DATA_DIR ?? path.join(io.homeDir, ".claxedo")),
    ...(typeof io.now === "number" ? { now: io.now } : {}),
  })
}

function clientOptions(flags: Flags, io: ResolvedCliIO) {
  return {
    projectDir: resolveFrom(io.cwd, flags.project, "."),
    homeDir: resolveFrom(io.cwd, flags.home, io.homeDir),
    dataRoot: resolveFrom(io.cwd, flags.cacheDir, process.env.CLAXEDO_DATA_DIR ?? path.join(io.homeDir, ".claxedo")),
    ...(typeof io.now === "number" ? { now: io.now } : {}),
  }
}

function runtimeDir(flags: Flags, io: ResolvedCliIO, projectDir: string) {
  return resolveFrom(io.cwd, flags.runtimeDir, path.join(projectDir, ".agent-extensions"))
}

async function projectState(input: {
  cwd: string
  projectDir: string
  stateRoot: string
}) {
  const sourceRoot = path.join(input.projectDir, FIRST_PARTY_AGENT_EXTENSIONS_DIR)
  return {
    sourceRoot,
    discovered: await discoverAgentExtensionComponents(sourceRoot),
    materialized: await readMaterializedRuntimeRecord(materializedRecordPath(input.stateRoot)),
  }
}

function printList(input: Awaited<ReturnType<typeof projectState>>, cwd: string) {
  const discovered = input.discovered.length === 0
    ? ["No first-party Agent Extension components discovered."]
    : [
        `Discovered ${input.discovered.length} component(s) in ${relative(cwd, input.sourceRoot)}:`,
        ...input.discovered.map((item) =>
          `- ${item.type}:${"runner" in item ? `${item.runner}:` : ""}${item.name}`
        ),
      ]
  const packages = Object.entries(input.materialized.packages)
  const materialized = packages.length === 0
    ? ["No materialized Agent Extension state found."]
    : [
        "Materialized packages:",
        ...packages.map(([id, pkg]) => `- ${id}: ${pkg.status} (${pkg.components.length} component(s))`),
      ]
  return [...discovered, "", ...materialized].join("\n")
}

async function list(flags: Flags, io: ResolvedCliIO) {
  const options = clientOptions(flags, io)
  const state = await projectState({
    cwd: io.cwd,
    projectDir: options.projectDir,
    stateRoot: runtimeDir(flags, io, options.projectDir),
  })
  if (flags.json) {
    io.stdout(json(state))
    return 0
  }
  io.stdout(printList(state, io.cwd))
  return 0
}

// Reuse packages already fetched into the durable install cache so
// materialize does not re-fetch GitHub sources into the runtime dir.
async function installedCacheRoots(snapshot: RuntimeAgentExtensionsSnapshot, dataRoot: string) {
  const entries = await Promise.all(snapshot.installs.map(async (install): Promise<Array<[string, string]>> => {
    if (install.desired.enabled === false || install.desired.source.type === "project") return []
    const sha = install.lock?.resolved_sha
    if (!sha) return []
    try {
      const root = cachePackageRoot({
        resolvedSha: sha,
        ...(install.lock?.package_path ? { packagePath: install.lock.package_path } : {}),
        dataRoot,
      })
      return await fs.stat(root).then((stat) => stat.isDirectory()).catch(() => false) ? [[install.desired.id, root]] : []
    } catch {
      return []
    }
  }))
  return Object.fromEntries(entries.flat())
}

async function materialize(flags: Flags, io: ResolvedCliIO) {
  const options = clientOptions(flags, io)
  const stateRoot = runtimeDir(flags, io, options.projectDir)
  const sourceRoot = path.join(options.projectDir, FIRST_PARTY_AGENT_EXTENSIONS_DIR)
  const discovered = await discoverAgentExtensionComponents(sourceRoot)
  // The snapshot carries every desired install (plus the discovered
  // first-party package), so replaying it preserves installs made with
  // `agent-extensions install` instead of erasing them.
  const snapshot = await getRuntimeAgentExtensionsSnapshot({ projectDir: options.projectDir })
  if (discovered.length === 0 && snapshot.installs.length === 0) {
    throw new Error(`No Agent Extension components found in ${relative(io.cwd, sourceRoot)}`)
  }
  const requested = targets(flags)
  const installs = snapshot.installs.map((install) =>
    requested && install.desired.id === FIRST_PARTY_AGENT_EXTENSION_ID
      ? { ...install, desired: { ...install.desired, targets: requested } }
      : install,
  )
  await applyRuntimeAgentExtensions({
    version: 1,
    installs,
  }, options.projectDir, {
    homeDir: options.homeDir,
    stateRoot,
    packageRoots: await installedCacheRoots(snapshot, options.dataRoot),
    ...(io.now !== undefined ? { now: io.now } : {}),
  })
  const state = await projectState({
    cwd: io.cwd,
    projectDir: options.projectDir,
    stateRoot,
  })
  if (flags.json) {
    io.stdout(json({
      sourceRoot,
      stateRoot,
      targets: targets(flags) ?? allHarnessTargets(),
      discovered,
      materialized: state.materialized.packages[FIRST_PARTY_AGENT_EXTENSION_ID],
    }))
    return 0
  }
  io.stdout([
    `Materialized ${discovered.length} first-party component(s) from ${relative(io.cwd, sourceRoot)}.`,
    `State: ${relative(io.cwd, stateRoot)}`,
    `Targets: ${(targets(flags) ?? allHarnessTargets()).join(", ")}`,
  ].join("\n"))
  return 0
}

async function install(flags: Flags, positionals: string[], io: ResolvedCliIO) {
  if (!flags.path && !positionals[0]) throw new Error("install requires a GitHub source or --path")
  const result = flags.path
    ? await client(flags, io).installCached({
        packagePath: flags.path,
        ...(flags.id ? { id: flags.id } : {}),
        ...(targets(flags) ? { targets: targets(flags) } : {}),
      })
    : await client(flags, io).install({
        source: positionals[0] ?? "",
        ...(flags.id ? { id: flags.id } : {}),
        ...(targets(flags) ? { targets: targets(flags) } : {}),
      })
  io.stdout(flags.json ? json(result) : `Installed ${result.id}: ${result.materialized.status}`)
  return 0
}

async function lifecycle(command: string, flags: Flags, positionals: string[], io: ResolvedCliIO) {
  const id = flags.id ?? positionals[0]
  if (!id) throw new Error(`${command} requires an id`)
  const extensions = client(flags, io)
  const result = command === "update"
    ? await extensions.update({ id })
    : command === "enable"
      ? await extensions.enable({ id })
      : command === "disable"
        ? await extensions.disable({ id })
        : await extensions.uninstall({ id })
  io.stdout(flags.json ? json({ id, result }) : `${command} ${id}: ${result ? "ok" : "not found"}`)
  return result ? 0 : 1
}

async function doctor(flags: Flags, io: ResolvedCliIO) {
  const result = await client(flags, io).doctor()
  if (flags.json) {
    io.stdout(json(result))
    return result.ok ? 0 : 1
  }
  io.stdout(result.ok ? "Agent Extensions state looks healthy." : result.issues.map((item) => `${item.code}: ${item.message}`).join("\n"))
  return result.ok ? 0 : 1
}

function validateCommandFlags(command: string, flags: Flags) {
  const runtimeCommands = new Set(["list", "materialize"])
  const lifecycleCommands = new Set(["install", "update", "enable", "disable", "uninstall", "doctor"])
  if (runtimeCommands.has(command) && flags.cacheDir) throw new Error(`${command} uses --runtime-dir, not --cache-dir`)
  if (lifecycleCommands.has(command) && flags.runtimeDir) throw new Error(`${command} uses --cache-dir, not --runtime-dir`)
}

export async function runAgentExtensionsCli(argv: string[] = process.argv.slice(2), io: CliIO = {}) {
  const out = io.stdout ?? ((text: string) => process.stdout.write(`${text}\n`))
  const err = io.stderr ?? ((text: string) => process.stderr.write(`${text}\n`))
  const fullIO = {
    cwd: io.cwd ?? process.cwd(),
    homeDir: io.homeDir ?? os.homedir(),
    now: io.now,
    stdout: out,
    stderr: err,
  }
  try {
    const parsed = parse(argv)
    if (parsed.flags.help || parsed.command === "help") {
      fullIO.stdout(usage())
      return 0
    }
    validateCommandFlags(parsed.command, parsed.flags)
    if (parsed.command === "list") return await list(parsed.flags, fullIO)
    if (parsed.command === "materialize") return await materialize(parsed.flags, fullIO)
    if (parsed.command === "install") return await install(parsed.flags, parsed.positionals, fullIO)
    if (["update", "enable", "disable", "uninstall"].includes(parsed.command)) {
      return await lifecycle(parsed.command, parsed.flags, parsed.positionals, fullIO)
    }
    if (parsed.command === "doctor") return await doctor(parsed.flags, fullIO)
    throw new Error(`Unknown command: ${parsed.command}`)
  } catch (error) {
    fullIO.stderr(error instanceof Error ? error.message : String(error))
    return 1
  }
}
