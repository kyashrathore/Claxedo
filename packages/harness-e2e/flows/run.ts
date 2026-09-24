import { readdir } from "node:fs/promises"
import { ensurePinnedPi } from "../harness/pinned-pi"
import { CONTRACT_DIST, ensureWorkspaceDist, HELPERS_DIST } from "../harness/workspace-dists"

for (const dist of [HELPERS_DIST, CONTRACT_DIST]) await ensureWorkspaceDist(dist)
const pi = await ensurePinnedPi()
console.log(`Pinned Pi ${pi.version}: ${pi.installed ? "installed" : "already installed"}`)

const entries = (await readdir(import.meta.dirname)).filter((name) => /^H\d+-.*\.flow\.ts$/.test(name)).sort()
if (!entries.length) throw new Error("No e2e flows found")
for (const entry of entries) {
  const flow = await import(`./${entry}`) as { run(): Promise<void> }
  console.log(`Running ${entry}`)
  await flow.run()
}
