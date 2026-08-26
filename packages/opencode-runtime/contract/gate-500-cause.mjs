/**
 * Surfaces the actual server-side cause of the §2.2 500s.
 *
 * LogOptions is `{ level, emit }` — an `emit` callback, not a writer object.
 * With that wired correctly the host's own logs should carry the defect behind
 * the 500.
 *
 *   node gate-500-cause.mjs
 */
import { OpenCode } from "@opencode-ai/sdk"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const entries = []
const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-cause-"))
const ws = path.join(root, "ws")
fs.mkdirSync(ws)

const oc = await OpenCode.create({
  database: { path: path.join(root, "c.db") },
  log: { level: "trace", emit: (entry) => entries.push(entry) },
})

const before = entries.length
try {
  await oc.config.get({ location: { directory: ws } })
  console.log("config.get unexpectedly SUCCEEDED")
} catch (error) {
  console.log("config.get failed:", error?.reason, JSON.stringify(error?.cause ?? {}))
}

console.log(`\n--- log entries emitted during config.get (${entries.length - before}) ---`)
for (const entry of entries.slice(before)) {
  const cause = entry.cause
    ? ` cause=${(cause_ => cause_)(cause instanceof Error ? `${cause.name}: ${cause.message}` : JSON.stringify(cause))}`
    : ""
  console.log(`[${entry.level}] ${entry.message}${cause}`)
  if (entry.attributes && Object.keys(entry.attributes).length) {
    console.log(`      attrs ${JSON.stringify(entry.attributes).slice(0, 500)}`)
  }
  if (entry.cause instanceof Error && entry.cause.stack) {
    console.log(`      stack ${entry.cause.stack.split("\n").slice(0, 6).join("\n            ")}`)
  }
}

if (entries.length - before === 0) {
  console.log("(none — the host emitted nothing for this request)")
  console.log(`\nTotal entries across startup: ${entries.length}`)
  for (const entry of entries.slice(0, 25)) console.log(`  [${entry.level}] ${entry.message}`)
}

await oc.close()
fs.rmSync(root, { recursive: true, force: true })
