/**
 * The 800-line budget for maintained source, with an exact ceiling for each
 * file that was already over it. A ceiling may only fall: `--lower` rewrites
 * ceilings down to what files measure and drops the ones back under budget,
 * and nothing here raises one.
 *
 * Tests, e2e, fixtures and translation dictionaries are not counted. Neither
 * is `packages/ui`: it is upstream's kit rebuilt from `UPSTREAM` plus
 * `patches/` by `sync-upstream.ts`, so its file shapes are upstream's.
 *
 *   bun script/file-size/verify.ts            # check
 *   bun script/file-size/verify.ts --lower    # record files that shrank
 */
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { readJsonFile } from "../../packages/claxedo-helpers/src/fs.ts"
import { isFiniteNumber, isRecord } from "../../packages/claxedo-helpers/src/guards.ts"

export const BUDGET = 800
const REPO_ROOT = path.resolve(import.meta.dirname, "../..")
const CEILINGS = path.join(import.meta.dirname, "ceilings.json")
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/
const NOT_COUNTED = [
  /\.d\.ts$/,
  /[.-](test|spec)\.[a-z]+$/,
  /(^|\/)(test|tests|__tests__|e2e|test-support|test-utils|fixtures?|locales)\//,
  /^packages\/ui\//,
  // Archived esbuild outputs contain vendor code; the maintained benchmark
  // sources outside reports remain counted.
  /^packages\/workspace-relay\/bench\/reports\/[^/]+\.bundle\.cjs$/,
]

export type Ceilings = Record<string, number>
export type Finding = { readonly file: string; readonly message: string }

export function counted(file: string): boolean {
  return CODE.test(file) && !NOT_COUNTED.some((pattern) => pattern.test(file))
}

export function lineCount(text: string): number {
  if (text.length === 0) return 0
  const lines = text.split("\n").length
  return text.endsWith("\n") ? lines - 1 : lines
}

export function check(sizes: ReadonlyMap<string, number>, ceilings: Ceilings): Finding[] {
  const findings: Finding[] = []
  for (const [file, lines] of sizes) {
    const ceiling = ceilings[file]
    if (ceiling === undefined) {
      if (lines > BUDGET) findings.push({ file, message: `${lines} lines; the budget is ${BUDGET}. Split it by responsibility.` })
      continue
    }
    if (lines > ceiling) findings.push({ file, message: `${lines} lines; its ceiling is ${ceiling}. Split it by responsibility.` })
    else if (lines <= BUDGET) findings.push({ file, message: `${lines} lines, back under the budget; run --lower to drop its ceiling.` })
    else if (lines < ceiling) findings.push({ file, message: `${lines} lines under a ceiling of ${ceiling}; run --lower to record it.` })
  }
  for (const file of Object.keys(ceilings)) {
    if (!sizes.has(file)) findings.push({ file, message: "has a ceiling but is not counted source any more; run --lower to drop it." })
  }
  return findings
}

export function lower(sizes: ReadonlyMap<string, number>, ceilings: Ceilings): Ceilings {
  const next: Ceilings = {}
  for (const [file, ceiling] of Object.entries(ceilings)) {
    const lines = sizes.get(file)
    if (lines === undefined || lines <= BUDGET) continue
    next[file] = Math.min(lines, ceiling)
  }
  return next
}

function measure(): Map<string, number> {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter((file) => file.length > 0 && counted(file))
  const sizes = new Map<string, number>()
  for (const file of files) {
    const full = path.join(REPO_ROOT, file)
    if (fs.existsSync(full)) sizes.set(file, lineCount(fs.readFileSync(full, "utf8")))
  }
  return sizes
}

function readCeilings(): Ceilings {
  const raw = readJsonFile(CEILINGS)
  if (!isRecord(raw)) throw new Error(`${CEILINGS} is not an object`)
  const ceilings: Ceilings = {}
  for (const [file, value] of Object.entries(raw)) {
    if (!isFiniteNumber(value)) throw new Error(`${CEILINGS}: ${file} has no numeric ceiling`)
    ceilings[file] = value
  }
  return ceilings
}

function writeCeilings(ceilings: Ceilings) {
  const sorted = Object.fromEntries(Object.entries(ceilings).sort(([a], [b]) => a.localeCompare(b)))
  fs.writeFileSync(CEILINGS, `${JSON.stringify(sorted, null, 2)}\n`)
}

if (import.meta.main) {
  const sizes = measure()
  if (sizes.size < 1000) throw new Error(`measured only ${sizes.size} files; the walk is broken, not the repo clean`)
  let ceilings = readCeilings()
  if (process.argv.includes("--lower")) {
    ceilings = lower(sizes, ceilings)
    writeCeilings(ceilings)
  }
  const findings = check(sizes, ceilings)
  for (const finding of findings) console.error(`✗ ${finding.file}: ${finding.message}`)
  if (findings.length > 0) process.exit(1)
  console.log(`file-size ratchet passed — ${sizes.size} files, ${Object.keys(ceilings).length} held at their ceilings, the rest ≤ ${BUDGET} lines`)
}
