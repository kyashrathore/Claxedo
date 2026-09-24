import { execFileSync } from "node:child_process"
import { isAbsolute, join, relative, sep } from "node:path"
import { packageRoot } from "./lib/files"
import { finish, type Violation } from "./lib/report"

const protectedAreas = [
  { flow: 30, name: "the transcript corpus", folders: ["src/transcript", "src/session/view/timeline"] },
  { flow: 31, name: "the session-list races", folders: ["src/session/list"] },
]
const packagePrefix = "packages/claxedo-app-v2/"

type Options = { readonly base?: string; readonly ran?: ReadonlySet<number>; readonly paths: readonly string[] }

function main(): never {
  const options = parseOptions(process.argv.slice(2))
  const changed = (options.paths.length > 0 ? options.paths : changedPaths(options.base)).map(packagePath)
  const required = requiredFlows(changed)
  if (!options.ran) {
    const flows = [...required.keys()].sort((a, b) => a - b)
    console.error(flows.length > 0 ? `protected areas changed: flows ${flows.join(" and ")} must run` : "no protected area changed")
    process.exit(0)
  }
  finish("protected-areas", packageRoot, skipped(required, options.ran), changed.length)
}

function requiredFlows(changed: readonly string[]): Map<number, string[]> {
  const required = new Map<number, string[]>()
  for (const path of changed) {
    for (const area of protectedAreas) {
      if (!area.folders.some((folder) => path === folder || path.startsWith(`${folder}/`))) continue
      required.set(area.flow, [...(required.get(area.flow) ?? []), path])
    }
  }
  return required
}

function skipped(required: ReadonlyMap<number, readonly string[]>, ran: ReadonlySet<number>): Violation[] {
  const violations: Violation[] = []
  for (const [flow, paths] of required) {
    if (ran.has(flow)) continue
    const area = protectedAreas.find((candidate) => candidate.flow === flow)
    for (const path of paths) {
      violations.push({ file: join(packageRoot, path), line: 1, message: `flow ${flow} (${area?.name ?? ""}) must run for a change here` })
    }
  }
  return violations
}

function parseOptions(argv: readonly string[]): Options {
  let base: string | undefined
  let ran: Set<number> | undefined
  const paths: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? ""
    if (argument === "--base") {
      base = argv[index + 1]
      index += 1
    } else if (argument === "--ran") {
      ran = new Set((argv[index + 1] ?? "").split(",").filter(Boolean).map(Number))
      index += 1
    } else paths.push(argument)
  }
  return { base, ran, paths }
}

function changedPaths(base: string | undefined): string[] {
  const diff = base ? git("diff", "--name-only", "--relative", `${base}...HEAD`) : git("diff", "--name-only", "--relative", "HEAD")
  const untracked = base ? [] : git("ls-files", "--others", "--exclude-standard")
  return [...new Set([...diff, ...untracked])]
}

function git(...args: string[]): string[] {
  const output = execFileSync("git", args, { cwd: packageRoot, encoding: "utf8" })
  return output.split("\n").filter(Boolean)
}

function packagePath(path: string): string {
  const normalized = (isAbsolute(path) ? relative(packageRoot, path) : path).split(sep).join("/")
  return normalized.startsWith(packagePrefix) ? normalized.slice(packagePrefix.length) : normalized
}

main()
