/**
 * Contract doc gate: can credential ownership be reconstructed through
 * `integration.list` / `integration.get`?
 *
 * V2 has no `credential.list`, so Claxedo's ownership ledger cannot protect
 * unmanaged SDK credentials by enumeration (Decision 9). This probe records
 * what identity the integration surface actually exposes, which decides
 * whether Unit 5 can match connections to the ledger or must fall back to
 * deleting only ledger-recorded IDs.
 *
 *   node gate-integration.mjs
 */
import { OpenCode } from "./dist-node/sdk-entry.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-integ-"))
const ws = path.join(root, "ws")
fs.mkdirSync(ws)

const logs = []
const oc = await OpenCode.create({
  database: { path: path.join(root, "contract.db") },
  log: { level: "debug", writer: { write: (entry) => logs.push(entry) } },
})

async function probe(label, run) {
  try {
    const value = await run()
    const rows = Array.isArray(value) ? value : (value?.data ?? value)
    console.log(`OK    ${label}`, JSON.stringify(rows).slice(0, 700))
    return rows
  } catch (error) {
    console.log(`ERR   ${label}`, error?.reason ?? "", JSON.stringify(error?.cause ?? {}))
    return undefined
  }
}

// IntegrationListInput takes a nested { location: { directory } }. Note this is
// the OPPOSITE nesting from SessionListInput, which takes a flat `directory`.
// The two shapes are easy to swap by mistake; the typed port must normalize.
await probe("integration.list (scoped)", () => oc.integration.list({ location: { directory: ws } }))
await probe("integration.list (bare)", () => oc.integration.list())
await probe("provider.list", () => oc.provider.list({ location: { directory: ws } }))
await probe("model.list", () => oc.model.list({ location: { directory: ws } }))
await probe("config.get", () => oc.config.get({ location: { directory: ws } }))

console.log("\n--- captured log tail ---")
for (const entry of logs.slice(-25)) {
  const line = typeof entry === "string" ? entry : JSON.stringify(entry)
  if (/error|fail|catalog|models|integration/i.test(line)) console.log(line.slice(0, 400))
}

await oc.close()
fs.rmSync(root, { recursive: true, force: true })
