/**
 * `debug.location.list` succeeds while `location.get` 500s. That asymmetry
 * should say what the location-resolving surface actually wants.
 *
 *   node gate-location-shape.mjs
 */
import { OpenCode } from "@opencode-ai/sdk"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-loc-"))
const ws = path.join(root, "ws")
fs.mkdirSync(ws)
const repo = process.env.REAL_REPO ?? process.cwd()

const oc = await OpenCode.create({ database: { path: path.join(root, "c.db") } })

async function show(label, run) {
  try {
    const value = await run()
    console.log(`OK  ${label}`, JSON.stringify(value?.data ?? value).slice(0, 400))
  } catch (error) {
    console.log(`ERR ${label}`, error?.reason ?? "", JSON.stringify(error?.cause ?? {}))
  }
}

// What locations does the host already know about?
await show("debug.location.list (before)", () => oc.debug.location.list())

// Creating a session evidently registers a location; does that change things?
await show("sessions.create(ws)", () => oc.sessions.create({ location: { directory: ws }, title: "probe" }))
await show("debug.location.list (after)", () => oc.debug.location.list())

// Same directory, now warm.
await show("location.get(ws)", () => oc.location.get({ directory: ws }))
await show("config.get(ws)", () => oc.config.get({ location: { directory: ws } }))

// A real, populated git repository rather than an empty temp dir.
await show("location.get(real repo)", () => oc.location.get({ directory: repo }))
await show("config.get(real repo)", () => oc.config.get({ location: { directory: repo } }))

// No location at all.
await show("config.get(no args)", () => oc.config.get())

await oc.close()
fs.rmSync(root, { recursive: true, force: true })
