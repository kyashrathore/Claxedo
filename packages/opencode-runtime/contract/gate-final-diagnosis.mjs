/**
 * Final diagnosis pass: dump full error objects and inspect what the host
 * considers a valid location, rather than only reading HTTP status codes.
 *
 *   node gate-final-diagnosis.mjs
 */
import { OpenCode } from "@opencode-ai/sdk"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as util from "node:util"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-diag-"))
const ws = path.join(root, "ws")
fs.mkdirSync(ws)
const oc = await OpenCode.create({ database: { path: path.join(root, "c.db") } })

function dump(label, error) {
  console.log(`--- ${label}`)
  console.log(util.inspect(error, { depth: 6, breakLength: 120, colors: false }).slice(0, 1600))
}

// A call that fails with something OTHER than UnexpectedStatus carries more.
try {
  await oc.workspace.create({})
} catch (error) {
  dump("workspace.create({})", error)
}

await oc.sessions.create({ location: { directory: ws }, title: "seed" })
const locations = await oc.debug.location.list().catch(() => undefined)
console.log("--- debug.location.list")
console.log(util.inspect(locations, { depth: 6 }).slice(0, 1200))

try {
  await oc.config.get({ location: { directory: ws } })
} catch (error) {
  dump("config.get", error)
}

// If debug.location.list named a location, ask about THAT one specifically.
const rows = Array.isArray(locations) ? locations : (locations?.data ?? [])
const first = rows[0]
if (first) {
  const directory = first.directory ?? first.location?.directory ?? first.id
  console.log("--- retrying with the host's own location:", JSON.stringify(directory))
  try {
    const value = await oc.config.get({ location: { directory } })
    console.log("OK config.get", JSON.stringify(value).slice(0, 300))
  } catch (error) {
    dump("config.get(host location)", error)
  }
}

await oc.close()
fs.rmSync(root, { recursive: true, force: true })
