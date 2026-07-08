import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { prodSourcePaths } from "../src/architecture/scanners"

type OwnershipEntry = {
  file: string
  status: "OWNED" | "TRACKED"
  owner: string
  reason: string
  budget?: number
}

const appRoot = path.resolve(import.meta.dir, "..")
const repoRoot = path.resolve(appRoot, "../..")
const appSrc = path.join(appRoot, "src")
const upstreamSrc = path.join(repoRoot, "packages/app/src")
const output = path.join(appRoot, "src/architecture/upstream-ownership.json")
const ownedGodFiles = new Set([
  "pages/session.tsx",
  "components/prompt-input.tsx",
  "context/global-sync.tsx",
  "pages/session/message-timeline.tsx",
])

const entries = prodSourcePaths(appRoot)
  .flatMap((file): OwnershipEntry[] => {
    const relative = path.relative(appSrc, file).split(path.sep).join("/")
    const twin = path.join(upstreamSrc, relative)
    if (!existsSync(twin)) return []

    const budget = divergence(readFileSync(file, "utf8"), readFileSync(twin, "utf8"))
    if (budget === 0) {
      return [
        {
          file: relative,
          status: "TRACKED",
          budget,
          owner: "upstream mirror",
          reason: "Byte-equivalent to packages/app/src twin; keep tracked for wholesale upstream sync.",
        },
      ]
    }
    if (budget >= 200 || ownedGodFiles.has(relative)) {
      return [
        {
          file: relative,
          status: "OWNED",
          owner: "claxedo app",
          reason: `${budget} divergent lines vs packages/app/src twin; owned Claxedo behavior, harvest upstream by idea.`,
        },
      ]
    }
    return [
      {
        file: relative,
        status: "TRACKED",
        budget,
        owner: "upstream mirror with Claxedo delta",
        reason: `${budget} divergent lines vs packages/app/src twin; budget must not grow.`,
      },
    ]
  })
  .sort((left, right) => left.file.localeCompare(right.file))

writeFileSync(output, `${JSON.stringify(entries, null, 2)}\n`)
console.log(`Wrote ${entries.length} entries to ${path.relative(appRoot, output)}`)

function divergence(ours: string, theirs: string) {
  const oursLines = countLines(ours)
  const theirsLines = countLines(theirs)
  return differenceSize(oursLines, theirsLines) + differenceSize(theirsLines, oursLines)
}

function countLines(text: string) {
  const counts = new Map<string, number>()
  for (const line of text.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1)
  return counts
}

function differenceSize(left: Map<string, number>, right: Map<string, number>) {
  return [...left].reduce((sum, [line, count]) => sum + Math.max(0, count - (right.get(line) ?? 0)), 0)
}
