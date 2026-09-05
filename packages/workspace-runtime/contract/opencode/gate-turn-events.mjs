/**
 * Can a REAL turn run, and what does it emit?
 *
 * gate-event-shapes showed V2 resolving a default model on its own
 * (opencode/nemotron-3.5-lightning-free) and reaching session.step.started. If
 * that free model answers without configured credentials, the whole assistant
 * event vocabulary Unit 4b must project becomes observable instead of guessed.
 *
 *   node gate-turn-events.mjs
 */
import { OpenCode } from "./dist-node/sdk-entry.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-turn-"))
const ws = path.join(root, "ws")
fs.mkdirSync(ws)
fs.writeFileSync(path.join(ws, "README.md"), "# probe\n")

const oc = await OpenCode.create({ database: { path: path.join(root, "c.db") } })
const seen = []
const stream = await oc.events.subscribe()
let done = false
const pump = (async () => {
  for await (const event of stream) {
    if (event?.type === "plugin.added") continue
    seen.push(event)
    if (event?.type === "session.execution.completed" || event?.type === "session.execution.failed") done = true
  }
})().catch(() => {})

const session = await oc.sessions.create({ location: { directory: ws }, title: "turn" })
await oc.sessions.prompt({ sessionID: session.id, text: "Reply with exactly: PONG" })

const deadline = Date.now() + 90_000
while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500))

console.log(`\nCAPTURED ${seen.length} events; completed=${done}\n`)
const order = []
for (const event of seen) {
  const type = event?.type ?? "(untyped)"
  if (order.at(-1) !== type) order.push(type)
}
console.log("SEQUENCE:", order.join(" -> "), "\n")
const byType = new Map()
for (const event of seen) if (!byType.has(event?.type)) byType.set(event?.type, event)
for (const [type, sample] of byType) {
  if (!String(type).startsWith("session.") && !String(type).startsWith("message")) continue
  console.log(`--- ${type} (${seen.filter((e) => e?.type === type).length}x)`)
  console.log("    " + JSON.stringify(sample).slice(0, 500))
}

const messages = await oc.message.list({ sessionID: session.id })
console.log("\nMESSAGE LIST:", JSON.stringify(messages).slice(0, 900))

await oc.close()
fs.rmSync(root, { recursive: true, force: true })
process.exit(0)
