import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { metrics, walkProdSources } from "./scanners"
import writers from "./writers.json"

type WritersManifest = {
  families: Array<{ family: string; writer: string; status: "live" | "planned" }>
  grandfathered: string[]
}

type SetQueryDataCall = {
  file: string
  line: number
  body: string
}

const manifest = writers as WritersManifest
const appRoot = path.resolve(import.meta.dir, "../..")
const srcRoot = path.join(appRoot, "src")
const setQueryDataMetric = metrics.find((metric) => metric.name === "setQueryDataCalls")
const phaseOneFamilies = new Set([
  "session/workspace query cache",
  "conversation messages",
  "session.status-meta",
  "session.inventory",
  "directory.sessionCache",
  "harness-config query cache",
])

if (!setQueryDataMetric) throw new Error("missing setQueryData scanner")

describe("single query-cache writer guard", () => {
  test("allows setQueryData only in declared writers or grandfathered files", () => {
    const allowed = new Set([...manifest.grandfathered, ...manifest.families.filter((item) => item.status === "live").map((item) => item.writer)])
    const offenders = [
      ...new Set(
        setQueryDataMetric
          .scan(walkProdSources(appRoot))
          .map((finding) => finding.file)
          .filter((file) => !allowed.has(file)),
      ),
    ].map((file) => `${file}: setQueryData outside its family writer -- add a writer in writers.json or remove the direct cache write`)

    expect(offenders).toEqual([])
  })

  test("keeps grandfathered entries live and pruned", () => {
    const filesWithSetQueryData = new Set(setQueryDataMetric.scan(walkProdSources(appRoot)).map((finding) => finding.file))
    const offenders = manifest.grandfathered.flatMap((file) => {
      if (!existsSync(path.join(srcRoot, file))) return [`${file} no longer exists -- remove it from writers.json grandfathered`]
      if (!filesWithSetQueryData.has(file)) return [`${file} no longer calls setQueryData -- remove it from writers.json grandfathered`]
      return []
    })

    expect(offenders).toEqual([])
  })

  test("keeps Phase-1 query families at zero grandfathered offenders", () => {
    const writerByFamily = new Map(
      manifest.families
        .filter((family) => family.status === "live" && phaseOneFamilies.has(family.family))
        .map((family) => [family.family, family.writer]),
    )
    const offenders = setQueryDataCalls(walkProdSources(appRoot)).flatMap((call) => {
      const family = phaseOneFamilyForSetQueryData(call)
      if (!family) return []
      const writer = writerByFamily.get(family)
      if (!writer) return [`${family}: missing live writer in writers.json`]
      if (manifest.grandfathered.includes(call.file)) return [`${call.file}:${call.line}: ${family} writer is still grandfathered`]
      if (call.file !== writer) return [`${call.file}:${call.line}: ${family} setQueryData must move to ${writer}`]
      return []
    })

    expect(offenders).toEqual([])
  })

  test("keeps live and planned writer paths honest", () => {
    const offenders = manifest.families.flatMap((family) => {
      const exists = existsSync(path.join(srcRoot, family.writer))
      if (family.status === "live" && !exists) return [`${family.family}: live writer ${family.writer} does not exist`]
      if (family.status === "planned" && exists) return [`${family.family}: planned writer ${family.writer} exists -- flip it to live in writers.json`]
      return []
    })

    expect(offenders).toEqual([])
  })

  test("keeps manifest entries unique", () => {
    expect(duplicates(manifest.families.map((family) => family.family))).toEqual([])
    expect(duplicates(manifest.grandfathered)).toEqual([])
  })
})

function duplicates(values: string[]) {
  return values.filter((value, index) => values.indexOf(value) !== index)
}

function setQueryDataCalls(files: Array<{ path: string; text: string }>): SetQueryDataCall[] {
  return files.flatMap((file) =>
    Array.from(file.text.matchAll(/\bsetQueryData(?:<[^>]+>)?\s*\(/g)).flatMap((match) => {
      const open = file.text.indexOf("(", match.index ?? 0)
      const close = matchingParen(file.text, open)
      if (open < 0 || close < 0) return []
      return [{
        file: file.path,
        line: lineForOffset(file.text, match.index ?? 0),
        body: file.text.slice(open + 1, close),
      }]
    }),
  )
}

function phaseOneFamilyForSetQueryData(call: SetQueryDataCall) {
  if (/sessionInventoryQueryOptions/.test(call.body)) return "session.inventory"
  if (/queryKeys\.directory\.sessionCache|directorySessionCacheQueryOptions/.test(call.body)) return "directory.sessionCache"
  if (/conversationSnapshotKey|shellDataKeys\.sessionId\([\s\S]*["']conversation["']/.test(call.body)) return "conversation messages"
  if (/promptSessionStatusMetaKey|["']status-meta["']/.test(call.body)) return "session.status-meta"
  if (/shellDataKeys\.sessionId\([\s\S]*["'](?:status|requests|todo|diff)["']/.test(call.body)) return "session/workspace query cache"
  if (/sessionModelSync(?:State|Request)Key|harness(?:PreparedSession(?:Seq)?|PreparingSession|Options(?:Seq|Tries)|Hydrate(?:Request|Seen)|ChangeRequest)Key/.test(call.body)) return "harness-config query cache"
  return
}

function matchingParen(text: string, open: number) {
  if (open < 0) return -1
  let depth = 0
  for (let index = open; index < text.length; index++) {
    if (text[index] === "(") depth++
    if (text[index] === ")") depth--
    if (depth === 0) return index
  }
  return -1
}

function lineForOffset(text: string, offset: number) {
  return text.slice(0, offset).split("\n").length
}
