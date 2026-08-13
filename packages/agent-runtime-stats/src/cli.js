import { readFileSync } from "node:fs"
import path from "node:path"

import { analyzeSessions } from "./analyze.js"
import { createScanProgress } from "./progress.js"
import { renderTable, sharePrompt } from "./render.js"
import { PUBLIC_ORIGIN } from "./share-contract.js"
import { discoverSources, HARNESSES, loadSessions } from "./sources.js"

const HELP = `agent-runtime-stats [options]

Analyze local coding-agent transcripts by minimum execution runtime.

Options:
  --harness NAMES       Comma-separated harnesses (default: all)
  --path HARNESS=PATH   Override/add a transcript path for a harness
  --home PATH           Override the home directory used for discovery
  --format table|json   Output format (default: table)
  --list-harnesses      Print supported harness names
  -h, --help            Print help
  -V, --version         Print version`
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version

function take(args, index, option) {
  if (args[index + 1] == null) throw new Error(`${option} requires a value`)
  return args[index + 1]
}

export function parseArgs(args, cwd = process.cwd()) {
  const options = { selected: [...HARNESSES], paths: new Map(), format: "table", home: null, action: null }
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === "-h" || argument === "--help") options.action = "help"
    else if (argument === "-V" || argument === "--version") options.action = "version"
    else if (argument === "--list-harnesses") options.action = "list"
    else if (argument === "--harness") {
      options.selected = take(args, index++, argument).split(",").filter(Boolean)
      if (!options.selected.length) throw new Error("--harness requires at least one harness name")
      const invalid = options.selected.find((harness) => !HARNESSES.includes(harness))
      if (invalid) throw new Error(`Unknown harness: ${invalid}. Valid harnesses: ${HARNESSES.join(", ")}`)
    } else if (argument === "--home") options.home = path.resolve(cwd, take(args, index++, argument))
    else if (argument === "--format") {
      options.format = take(args, index++, argument)
      if (!new Set(["table", "json"]).has(options.format)) throw new Error("--format must be table or json")
    } else if (argument === "--path") {
      const value = take(args, index++, argument)
      const separator = value.indexOf("=")
      if (separator <= 0 || separator === value.length - 1)
        throw new Error("--path must use harness=/absolute/or/relative/path")
      const harness = value.slice(0, separator)
      if (!HARNESSES.includes(harness)) {
        throw new Error(`Unknown harness: ${harness}. Valid harnesses: ${HARNESSES.join(", ")}`)
      }
      const paths = options.paths.get(harness) ?? []
      paths.push(path.resolve(cwd, value.slice(separator + 1)))
      options.paths.set(harness, paths)
    } else throw new Error(`Unknown option: ${argument}`)
  }
  return options
}

export function homeDirectory(explicit, environment) {
  if (explicit) return explicit
  if (environment.HOME) return environment.HOME
  if (environment.USERPROFILE) return environment.USERPROFILE
  if (environment.HOMEDRIVE && environment.HOMEPATH) return `${environment.HOMEDRIVE}${environment.HOMEPATH}`
  throw new Error("Cannot locate the home directory; pass --home")
}

export async function main(args, io = { stdout: process.stdout, stderr: process.stderr }, environment = process.env) {
  const options = parseArgs(args)
  if (options.action === "help") {
    io.stdout.write(`${HELP}\n`)
    return 0
  }
  if (options.action === "version") {
    io.stdout.write(`${VERSION}\n`)
    return 0
  }
  if (options.action === "list") {
    io.stdout.write(`${HARNESSES.join("\n")}\n`)
    return 0
  }
  const home = homeDirectory(options.home, environment)
  const dataHome = options.home ? null : environment.XDG_DATA_HOME
  const sources = discoverSources(home, dataHome, options.selected, options.paths)
  const total = sources.reduce((count, source) => count + (source.kind === "unsupported" ? 0 : source.files.length), 0)
  const progress = createScanProgress(io.stderr, total)
  let loaded
  try {
    loaded = await loadSessions(sources, (state) => progress.update(state))
  } finally {
    progress.stop(loaded?.errors.length ?? 0)
  }
  const report = {
    ...analyzeSessions(loaded.sessions),
    sources: sources.map(({ harness, status, files, note }) => ({
      harness,
      status,
      stores: files.length,
      ...(note ? { note } : {}),
    })),
    errors: loaded.errors,
    warnings: loaded.warnings,
  }
  if (options.format === "json") io.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else {
    const colors = io.stdout.isTTY === true && !("NO_COLOR" in environment)
    io.stdout.write(`${renderTable(report, io.stdout.columns, colors)}\n\n`)
    const sharing = sharePrompt(
      report,
      environment.AGENT_RUNTIME_STATS_SHARE_URL ?? PUBLIC_ORIGIN,
      io.stdout.isTTY === true,
    )
    if (sharing) io.stdout.write(`${sharing}\n`)
  }
  return report.errors.length ? 2 : 0
}
