/**
 * The decisive viability question: can the embedded SDK actually RUN a turn?
 *
 * Session CRUD works, but `session.prompt` also has to resolve an agent and a
 * model. This retains the original end-to-end viability probe after upstream
 * removed the filesystem/search cycle that made those lookups return 500.
 *
 * A credential error would be GOOD news here: it would mean agent/model
 * resolution succeeded and only auth is missing, which is expected without keys.
 * A 500, or a hang, means the execution path is blocked by the same defect.
 *
 *   node gate-prompt-viability.mjs
 */
import { OpenCode } from "./dist-node/sdk-entry.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as util from "node:util"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-prompt-"))
const ws = path.join(root, "ws")
fs.mkdirSync(ws)
fs.writeFileSync(path.join(ws, "README.md"), "# probe\n")

const oc = await OpenCode.create({ database: { path: path.join(root, "c.db") } })
const session = await oc.sessions.create({ location: { directory: ws }, title: "prompt probe" })
console.log("SESSION", session.id)

async function attempt(label, run) {
  try {
    const value = await run()
    console.log(`OK  ${label}`, JSON.stringify(value).slice(0, 300))
  } catch (error) {
    console.log(`ERR ${label}`, util.inspect(error, { depth: 3 }).slice(0, 400))
  }
}

// V2's prompt input is FLAT: { sessionID, text, ... }. There is no `parts`
// array and no per-call `model` — the model comes from agent/config
// resolution, which is exactly the path that used to 500.
await attempt("sessions.prompt (default agent/model)", () =>
  oc.sessions.prompt({ sessionID: session.id, text: "say hi" }),
)

await attempt("agent.list", () => oc.agent.list({ location: { directory: ws } }))
await attempt("provider.list", () => oc.provider.list({ location: { directory: ws } }))

await attempt("sessions.messages after prompt", () => oc.message.list({ sessionID: session.id }))

await oc.close()
fs.rmSync(root, { recursive: true, force: true })
