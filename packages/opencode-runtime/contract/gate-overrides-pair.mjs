/**
 * Second attempt at the §2.2 fix, now with the CORRECT override shape.
 *
 * `LayerNode.Replacements` is `readonly [source, replacement][]` — an array of
 * PAIRS. My first attempt passed a flat `[WorkspaceDriver.node]`, which is
 * malformed and was ignored, so that result proved nothing.
 *
 * The host's own workspaceProviders branch does exactly:
 *
 *   [...embed.overrides ?? [], [WorkspaceDriver.node, WorkspaceDriver.registryNode(providers)]]
 *
 * i.e. REPLACE the default `WorkspaceDriver.node` with a registry. That is
 * expressible through the public `embed` parameter, so if it lights up the
 * location surface the cutover is unblocked with public API only.
 *
 *   node gate-overrides-pair.mjs
 */
import { OpenCode } from "@opencode-ai/sdk"
import { WorkspaceDriver } from "@opencode-ai/core/workspace/driver"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

async function run(label, embed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-pair-"))
  const ws = path.join(root, "ws")
  fs.mkdirSync(ws)
  console.log(`\n[${label}]`)
  try {
    const oc = await OpenCode.create({ database: { path: path.join(root, "c.db") } }, embed)
    for (const [name, call] of [
      ["location.get", () => oc.location.get({ directory: ws })],
      ["config.get", () => oc.config.get({ location: { directory: ws } })],
      ["agent.list", () => oc.agent.list({ location: { directory: ws } })],
      ["provider.list", () => oc.provider.list({ location: { directory: ws } })],
    ]) {
      try {
        const value = await call()
        const rows = value?.data ?? value
        console.log(`  OK  ${name}`, Array.isArray(rows) ? `count=${rows.length}` : JSON.stringify(rows).slice(0, 200))
      } catch (error) {
        console.log(`  ERR ${name}`, error?.reason ?? "", JSON.stringify(error?.cause ?? {}))
      }
    }
    await oc.close()
  } catch (error) {
    console.log("  CREATE FAILED", String(error).slice(0, 260))
  }
  fs.rmSync(root, { recursive: true, force: true })
}

await run("baseline (no embed)", undefined)
await run("replace node -> registryNode({})", {
  overrides: [[WorkspaceDriver.node, WorkspaceDriver.registryNode({})]],
})
