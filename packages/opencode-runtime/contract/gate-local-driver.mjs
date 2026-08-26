/**
 * The real fix attempt for §2.2.
 *
 * Root cause established from source: `WorkspaceDriver.node` is literally
 * `registryNode({})` — an EMPTY provider registry. `workspace.create` demands a
 * `provider` that must exist in it, nothing can register one because the public
 * `CreateOptions` omits `workspaceProviders`, so no location ever provisions
 * and every location-resolving API 500s.
 *
 * But `create(options, embed)`'s `embed.overrides` is a public parameter and
 * takes `[source, replacement]` pairs, and `@opencode-ai/core` exports `./*`
 * publicly. So we can replace the empty registry with one containing a real
 * local driver, built on the published `makeLocalDriver`.
 *
 * All public exports. No dist/internal. If this works the cutover is unblocked.
 *
 *   node gate-local-driver.mjs
 */
import { OpenCode } from "@opencode-ai/sdk"
import { WorkspaceDriver } from "@opencode-ai/core/workspace/driver"
import { makeLocalDriver } from "@opencode-ai/core/environment/local"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as util from "node:util"

const localDriver = WorkspaceDriver.make({
  create: () => Effect.succeed({ binding: {} }),
  connect: () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner
      return makeLocalDriver(spawner)
    }),
  suspendForIdle: () => Effect.void,
  destroy: () => Effect.void,
})

const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-local-"))
const ws = path.join(root, "ws")
fs.mkdirSync(ws)

console.log("registering provider 'local' via embed.overrides")
let oc
try {
  oc = await OpenCode.create(
    { database: { path: path.join(root, "c.db") } },
    { overrides: [[WorkspaceDriver.node, WorkspaceDriver.registryNode({ local: localDriver })]] },
  )
} catch (error) {
  console.log("CREATE FAILED", util.inspect(error, { depth: 4 }).slice(0, 800))
  process.exit(1)
}

async function show(label, run) {
  try {
    const value = await run()
    const rows = value?.data ?? value
    console.log(`OK  ${label}`, Array.isArray(rows) ? `count=${rows.length}` : JSON.stringify(rows).slice(0, 260))
  } catch (error) {
    console.log(`ERR ${label}`, error?.reason ?? error?._tag ?? "", JSON.stringify(error?.cause ?? error?.message ?? {}).slice(0, 200))
  }
}

await show("workspace.create(local)", () => oc.workspace.create({ provider: "local" }))
await show("sessions.create", () => oc.sessions.create({ location: { directory: ws }, title: "probe" }))
await show("debug.location.list", () => oc.debug.location.list())
await show("location.get", () => oc.location.get({ directory: ws }))
await show("config.get", () => oc.config.get({ location: { directory: ws } }))
await show("agent.list", () => oc.agent.list({ location: { directory: ws } }))
await show("provider.list", () => oc.provider.list({ location: { directory: ws } }))

await oc.close()
fs.rmSync(root, { recursive: true, force: true })
