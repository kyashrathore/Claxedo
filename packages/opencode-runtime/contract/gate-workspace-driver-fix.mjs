/**
 * Tests the candidate fix for the §2.2 gate.
 *
 * `OpenCode.create(options, embed)` takes a SECOND public parameter,
 * `embed: { overrides?: LayerNode.Replacements }`, and the host feeds exactly
 * that into the layer graph. The 500s look like a missing
 * `WorkspaceDriver.node`, which the host installs only when
 * `workspaceProviders` is passed — and the public options type omits that
 * field.
 *
 * But `@opencode-ai/core` exports `./*` as a public wildcard, so
 * `@opencode-ai/core/workspace/driver` is a documented subpath, NOT a
 * dist/internal deep import. If supplying the driver through `embed.overrides`
 * lights up config/provider/agent, the cutover is unblocked using only public
 * API — no Decision 15 violation.
 *
 *   node gate-workspace-driver-fix.mjs
 */
import { OpenCode } from "@opencode-ai/sdk"
import { WorkspaceDriver } from "@opencode-ai/core/workspace/driver"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

async function run(label, embed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-wd-"))
  const ws = path.join(root, "ws")
  fs.mkdirSync(ws)
  console.log(`\n[${label}]`)
  try {
    const oc = await OpenCode.create({ database: { path: path.join(root, "c.db") } }, embed)
    for (const [name, call] of [
      ["config.get", () => oc.config.get({ location: { directory: ws } })],
      ["provider.list", () => oc.provider.list({ location: { directory: ws } })],
      ["agent.list", () => oc.agent.list({ location: { directory: ws } })],
      ["location.get", () => oc.location.get({ directory: ws })],
      ["sessions.create", () => oc.sessions.create({ location: { directory: ws }, title: "t" })],
    ]) {
      try {
        const value = await call()
        const rows = value?.data ?? value
        console.log(`  OK  ${name}`, Array.isArray(rows) ? `count=${rows.length}` : JSON.stringify(rows).slice(0, 130))
      } catch (error) {
        console.log(`  ERR ${name}`, error?.reason ?? "", JSON.stringify(error?.cause ?? {}))
      }
    }
    await oc.close()
  } catch (error) {
    console.log("  CREATE FAILED", String(error).slice(0, 220))
  }
  fs.rmSync(root, { recursive: true, force: true })
}

console.log("WorkspaceDriver.node is", typeof WorkspaceDriver?.node, "| registryNode is", typeof WorkspaceDriver?.registryNode)

await run("baseline: no embed overrides", undefined)
await run("candidate: embed.overrides = [WorkspaceDriver.node]", { overrides: [WorkspaceDriver.node] })
await run("candidate: overrides = [node, registryNode({})]", {
  overrides: [WorkspaceDriver.node, WorkspaceDriver.registryNode({})],
})
