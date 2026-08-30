/**
 * What does the V2 event stream actually emit?
 *
 * Unit 4b has to project these onto Claxedo's AgentRuntimeStreamEvent, and the
 * V1 SSE shapes it currently projects (message.part.updated, message.part.delta,
 * session.error, session.status) are not necessarily what V2 sends. Recording
 * the real envelopes beats reading the union type: the type says what CAN be
 * emitted, this says what a create + prompt DOES emit.
 *
 *   node gate-event-shapes.mjs
 */
import { OpenCode } from "./dist-node/sdk-entry.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-events-"))
const ws = path.join(root, "ws")
fs.mkdirSync(ws)
fs.writeFileSync(path.join(ws, "README.md"), "# probe\n")

const oc = await OpenCode.create({ database: { path: path.join(root, "c.db") } })

const seen = []
const stream = await oc.events.subscribe()
const pump = (async () => {
  for await (const event of stream) {
    // `plugin.added` fires ~56 times at boot and would swamp the buffer before
    // any execution event arrives. It is not interesting to the projector.
    if (event?.type === "plugin.added") continue
    seen.push(event)
    if (seen.length > 120) break
  }
})().catch((error) => console.log("STREAM ENDED", String(error).slice(0, 200)))

const session = await oc.sessions.create({ location: { directory: ws }, title: "events" })
await oc.sessions.prompt({ sessionID: session.id, text: "hello" })
await oc.sessions.rename({ sessionID: session.id, title: "renamed" })
await new Promise((resolve) => setTimeout(resolve, 4000))
await oc.sessions.interrupt({ sessionID: session.id })
await new Promise((resolve) => setTimeout(resolve, 1500))

console.log(`\nCAPTURED ${seen.length} events\n`)
const byType = new Map()
for (const event of seen) {
  const type = event?.type ?? "(untyped)"
  if (!byType.has(type)) byType.set(type, event)
}
for (const [type, sample] of byType) {
  console.log(`--- ${type} (${seen.filter((e) => e?.type === type).length}x)`)
  console.log("    keys:", Object.keys(sample).join(", "))
  console.log("    " + JSON.stringify(sample).slice(0, 420))
}

await oc.close()
fs.rmSync(root, { recursive: true, force: true })
process.exit(0)
