import { readdir } from "node:fs/promises"
import { isRecord } from "@claxedo/helpers/guards"
import { daemonRuntime } from "../harness/daemon"
import { ensurePinnedPi } from "../harness/pinned-pi"
import { CONTRACT_DIST, ensureWorkspaceDist, HELPERS_DIST } from "../harness/workspace-dists"

type Flow = { run(): Promise<void> }

function isFlow(value: unknown): value is Flow {
  return isRecord(value) && typeof value.run === "function"
}

function selected(entries: string[], ids: string[]) {
  if (!ids.length) return entries
  const unknown = ids.filter((id) => !entries.some((entry) => entry.startsWith(`${id}-`)))
  if (unknown.length) throw new Error(`No flow file for ${unknown.join(", ")}`)
  return entries.filter((entry) => ids.some((id) => entry.startsWith(`${id}-`)))
}

for (const dist of [HELPERS_DIST, CONTRACT_DIST]) await ensureWorkspaceDist(dist)
const pi = await ensurePinnedPi()
console.log(`Pinned Pi ${pi.version}: ${pi.installed ? "installed" : "already installed"}`)
const runtime = await daemonRuntime()
console.log(`Daemon runtime: Node ${runtime.version} (${runtime.node})`)

const all = (await readdir(import.meta.dirname)).filter((name) => /^H\d+[a-z]?-.*\.flow\.ts$/.test(name)).sort()
if (!all.length) throw new Error("No e2e flows found")
for (const entry of selected(all, process.argv.slice(2))) {
  const flow: unknown = await import(`./${entry}`)
  if (!isFlow(flow)) throw new Error(`${entry} exports no run()`)
  console.log(`Running ${entry}`)
  await flow.run()
}
