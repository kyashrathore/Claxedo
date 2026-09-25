import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { isRecord } from "@claxedo/helpers/guards"
import { daemonRuntime } from "../harness/daemon"
import { ensurePinnedPi } from "../harness/pinned-pi"
import { CONTRACT_DIST, ensureWorkspaceDist, HELPERS_DIST } from "../harness/workspace-dists"

type Flow = { run(): Promise<void> }

function isFlow(value: unknown): value is Flow {
  return isRecord(value) && typeof value.run === "function"
}

function flowId(entry: string) {
  return entry.slice(0, entry.indexOf("-"))
}

function selected(entries: string[], ids: string[]) {
  if (!ids.length) return entries
  const unknown = ids.filter((id) => !entries.some((entry) => flowId(entry) === id))
  if (unknown.length) throw new Error(`No flow file for ${unknown.join(", ")}`)
  return entries.filter((entry) => ids.includes(flowId(entry)))
}

async function expectedRed(entries: string[]): Promise<Map<string, string[]>> {
  const file = path.join(import.meta.dirname, "expected-red.json")
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"))
  if (!isRecord(parsed)) throw new Error(`${file} must map flow ids to defect ids`)
  const expected = new Map<string, string[]>()
  for (const [id, defects] of Object.entries(parsed)) {
    if (!entries.some((entry) => flowId(entry) === id)) throw new Error(`${file} names ${id}, which has no flow file`)
    if (!Array.isArray(defects) || !defects.length || !defects.every((defect) => typeof defect === "string" && /^[HCT]-\d+$/.test(defect))) {
      throw new Error(`${file} must give ${id} a non-empty list of defect ids from the plan's register`)
    }
    expected.set(id, defects)
  }
  return expected
}

function firstLine(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0]
}

for (const dist of [HELPERS_DIST, CONTRACT_DIST]) await ensureWorkspaceDist(dist)
const pi = await ensurePinnedPi()
console.log(`Pinned Pi ${pi.version}: ${pi.installed ? "installed" : "already installed"}`)
const runtime = await daemonRuntime()
console.log(`Daemon runtime: Node ${runtime.version} (${runtime.node})`)

const all = (await readdir(import.meta.dirname)).filter((name) => /^H\d+[a-z]?-.*\.flow\.ts$/.test(name)).sort()
if (!all.length) throw new Error("No e2e flows found")
const red = await expectedRed(all)
const failures: string[] = []
for (const entry of selected(all, process.argv.slice(2))) {
  const flow: unknown = await import(`./${entry}`)
  if (!isFlow(flow)) throw new Error(`${entry} exports no run()`)
  const id = flowId(entry)
  const defects = red.get(id)
  console.log(`Running ${entry}`)
  try {
    await flow.run()
    if (defects) failures.push(`${id} passed but is expected red for ${defects.join(", ")}: remove it from expected-red.json once the fix is proven`)
  } catch (error) {
    if (defects) {
      console.log(`${id} red as expected (${defects.join(", ")}): ${firstLine(error)}`)
      continue
    }
    console.error(error)
    failures.push(`${id} failed: ${firstLine(error)}`)
  }
}
if (failures.length) {
  console.error(`\n${failures.join("\n")}`)
  process.exitCode = 1
}
