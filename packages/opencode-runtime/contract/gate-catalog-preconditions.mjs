/**
 * Last isolation step before calling the config/catalog 500 an SDK defect.
 *
 * Tries the plausible preconditions: resolving the location first, creating a
 * workspace, and calling the surfaces with no location at all. If every path
 * still 500s while session CRUD succeeds, the surface is broken in this
 * release rather than misused by us.
 *
 *   node gate-catalog-preconditions.mjs
 */
import { OpenCode } from "./dist-node/sdk-entry.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-pre-"))
const ws = path.join(root, "ws")
fs.mkdirSync(ws)
const oc = await OpenCode.create({ database: { path: path.join(root, "contract.db") } })

async function attempt(label, run) {
  try {
    const value = await run()
    const rows = value?.data ?? value
    console.log(`OK  ${label}`, Array.isArray(rows) ? `count=${rows.length}` : JSON.stringify(rows).slice(0, 220))
    return value
  } catch (error) {
    console.log(`ERR ${label}`, error?.reason ?? "", JSON.stringify(error?.cause ?? {}))
    return undefined
  }
}

await attempt("health.get", () => oc.health.get())
await attempt("server.get", () => oc.server.get())
await attempt("location.get", () => oc.location.get({ directory: ws }))
await attempt("project.list", () => oc.project.list())
await attempt("project.current", () => oc.project.current({ location: { directory: ws } }))
await attempt("agent.list", () => oc.agent.list({ location: { directory: ws } }))
await attempt("command.list", () => oc.command.list({ location: { directory: ws } }))
await attempt("skill.list", () => oc.skill.list({ location: { directory: ws } }))
await attempt("debug.location.list", () => oc.debug.location.list())

// control: session CRUD is known-good
await attempt("sessions.create (control)", () => oc.sessions.create({ location: { directory: ws }, title: "pre" }))

// now retry config/catalog after the location is warm
await attempt("config.get (after warm)", () => oc.config.get({ location: { directory: ws } }))
await attempt("config.get (no args)", () => oc.config.get())
await attempt("model.list (no args)", () => oc.model.list())
await attempt("provider.list (no args)", () => oc.provider.list())

await oc.close()
fs.rmSync(root, { recursive: true, force: true })
