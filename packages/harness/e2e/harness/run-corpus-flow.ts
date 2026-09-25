import { readFile } from "node:fs/promises"
import path from "node:path"
import { daemonRuntime } from "./daemon"
import { ensurePinnedPi } from "./pinned-pi"
import { CONTRACT_DIST, ensureWorkspaceDist, HELPERS_DIST } from "./workspace-dists"

const name = process.argv[2]
if (!name || process.argv.length !== 3 || !/^H\d+[a-z]?(?:\.[a-z0-9]+)?-[a-z0-9-]+$/.test(name)) {
  throw new Error("Pass exactly one flow filename without .flow.ts")
}
const defects = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../flows/expected-red.json"), "utf8")) as Record<string, string[]>
const id = name.slice(0, name.indexOf("-"))
if (defects[id]) throw new Error(`${name} is expected red for ${defects[id].join(", ")}`)

for (const dist of [HELPERS_DIST, CONTRACT_DIST]) await ensureWorkspaceDist(dist)
const pi = await ensurePinnedPi()
console.log(`Pinned Pi ${pi.version}: ${pi.installed ? "installed" : "already installed"}`)
const runtime = await daemonRuntime()
console.log(`Daemon runtime: Node ${runtime.version} (${runtime.node})`)

const flow: unknown = await import(`../flows/${name}.flow.ts`)
if (!flow || typeof flow !== "object" || !("run" in flow) || typeof flow.run !== "function") throw new Error(`${name} exports no run()`)
console.log(`Running ${name}.flow.ts`)
await flow.run()
