/**
 * `debug.location.list` returns [] even after a session exists, so nothing is
 * registered as a location. The client exposes `workspace.create`. Maybe the
 * location-resolving surface requires a provisioned workspace first.
 *
 *   node gate-workspace-create.mjs
 */
import { OpenCode } from "@opencode-ai/sdk"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-wsc-"))
const ws = path.join(root, "ws")
fs.mkdirSync(ws)
const oc = await OpenCode.create({ database: { path: path.join(root, "c.db") } })

async function show(label, run) {
  try {
    const value = await run()
    const rows = value?.data ?? value
    console.log(`OK  ${label}`, Array.isArray(rows) ? `count=${rows.length}` : JSON.stringify(rows).slice(0, 300))
    return value
  } catch (error) {
    console.log(`ERR ${label}`, error?.reason ?? "", JSON.stringify(error?.cause ?? {}))
    return undefined
  }
}

await show("project.list (before)", () => oc.project.list())
await show("workspace.create", () => oc.workspace.create({ provider: "node", workspaceID: "ws-probe" }))
await show("workspace.create (bare)", () => oc.workspace.create({}))
await show("project.list (after)", () => oc.project.list())
await show("debug.location.list", () => oc.debug.location.list())
await show("config.get", () => oc.config.get({ location: { directory: ws } }))

await oc.close()
fs.rmSync(root, { recursive: true, force: true })
