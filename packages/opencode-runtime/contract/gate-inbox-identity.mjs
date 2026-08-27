/**
 * Is the id `prompt` returns the SAME id that lands in `message.list`?
 *
 * An earlier note recorded prompt's id as "an inbox entry, not a message",
 * because staging a revert against it immediately after prompting failed with
 * MessageNotFoundError. gate-turn-events shows message.list carrying that very
 * id once the turn ran. If the id is the same and only the TIMING differs, the
 * projector's rule is "wait for session.inbox.delivered", not "look the id up
 * again" - a materially different design.
 */
import { OpenCode, repairCoreLayerGraph } from "./dist-node/sdk-entry.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

repairCoreLayerGraph()
const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-inbox-"))
const ws = path.join(root, "ws")
fs.mkdirSync(ws)
fs.writeFileSync(path.join(ws, "README.md"), "# probe\n")

const oc = await OpenCode.create({ database: { path: path.join(root, "c.db") } })
let delivered
const stream = await oc.events.subscribe()
;(async () => {
  for await (const event of stream) {
    if (event?.type === "session.inbox.delivered") delivered = event.data.inboxID
  }
})().catch(() => {})

const session = await oc.sessions.create({ location: { directory: ws }, title: "identity" })
const admitted = await oc.sessions.prompt({ sessionID: session.id, text: "hello" })
console.log("prompt returned id :", admitted.id)

const attempt = async (label) => {
  try {
    await oc.sessions.revert.stage({ sessionID: session.id, messageID: admitted.id })
    console.log(`  ${label}: revert.stage OK`)
    await oc.sessions.revert.clear({ sessionID: session.id })
  } catch (error) {
    console.log(`  ${label}: revert.stage ERR ${error?._tag ?? error?.name}`)
  }
  const list = await oc.message.list({ sessionID: session.id })
  console.log(`  ${label}: message.list ids =`, list.data.map((m) => `${m.type}:${m.id}`).join(", ") || "(empty)")
}

await attempt("immediately    ")
const deadline = Date.now() + 60_000
while (!delivered && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250))
console.log("delivered inboxID  :", delivered, "| same as prompt id:", delivered === admitted.id)
await attempt("after delivery ")

await oc.close()
fs.rmSync(root, { recursive: true, force: true })
process.exit(0)
