/**
 * End-to-end gate: can the public SDK serve what the Claxedo app asks for on
 * first paint?
 *
 * The app's shell issues `GET /global/config` immediately. In
 * `claxedo-local-server/src/opencode/compat-routes/index.ts:271` that route
 * calls `globalConfigBody()`, which today reaches the vendored engine's
 * `/global/config`. Under the cutover it becomes `client.config.get()`.
 *
 * This script asks both runtimes the same question, so the comparison is
 * evidence rather than assertion:
 *
 *   A. the RUNNING local server (vendored fork, under Node)  -> GET /global/config
 *   B. the pinned public SDK through our own runtime package -> config.get()
 *
 *   node gate-app-startup-path.mjs
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { OpenCode } from "./dist-node/sdk-entry.js"

const serverUrl = process.env.CLAXEDO_SERVER ?? "http://127.0.0.1:2593"

console.log("A. vendored fork, via the running local server")
try {
  const response = await fetch(`${serverUrl}/global/config`)
  const body = await response.text()
  console.log(`   status ${response.status}  body ${body.slice(0, 160)}`)
} catch (error) {
  console.log(`   unreachable: ${String(error).slice(0, 120)} (is the local server running under Node?)`)
}

console.log("B. pinned public SDK, via OpenCode.create()")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-startup-"))
const ws = path.join(root, "ws")
fs.mkdirSync(ws)
const oc = await OpenCode.create({ database: { path: path.join(root, "contract.db") } })

for (const [label, run] of [
  ["config.get      (backs GET /global/config)", () => oc.config.get({ location: { directory: ws } })],
  ["provider.list   (backs the provider catalog)", () => oc.provider.list({ location: { directory: ws } })],
  ["agent.list      (backs GET /agent)", () => oc.agent.list({ location: { directory: ws } })],
  ["sessions.create (backs session start)", () => oc.sessions.create({ location: { directory: ws }, title: "x" })],
]) {
  try {
    const value = await run()
    console.log(`   OK  ${label}`, JSON.stringify(value?.data ?? value).slice(0, 120))
  } catch (error) {
    console.log(`   ERR ${label}`, error?.reason ?? "", JSON.stringify(error?.cause ?? {}))
  }
}

await oc.close()
fs.rmSync(root, { recursive: true, force: true })

console.log("")
console.log("Read: session execution is portable today; the app's first-paint")
console.log("config/catalog path is not. That is the §2.2 gate, reproduced through")
console.log("the route the product actually calls.")
