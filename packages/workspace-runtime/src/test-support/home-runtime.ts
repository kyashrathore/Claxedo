import { createHarnessServices } from "../harness-services"
import { LAUNCH_OWNERSHIP_SCHEMA } from "@claxedo/session-core"
import { sqliteLaunchOwnership } from "../ownership/launch-ownership-sqlite"
import { openSqliteDatabase } from "../sqlite/node"

const [home, ledger] = process.argv.slice(2)
if (!home || !ledger) throw new Error("usage: home-runtime.ts <home> <launch-ledger>")
const db = openSqliteDatabase(ledger)
for (const statement of LAUNCH_OWNERSHIP_SCHEMA) db.exec(statement)
const services = createHarnessServices({
  ownership: sqliteLaunchOwnership(db, { ownerGeneration: "home-runtime", scope: { kind: "standalone" } }),
  log: { debug() {}, info() {}, warn() {}, error() {} },
  clock: { now: Date.now, setTimeout, clearTimeout },
  patternEvaluator: async () => {},
  healthChanged: () => {},
})
await services.recordHomeUse(home)
const harness = await services.spawn({ file: process.execPath, args: ["-e", "setTimeout(() => {}, 60_000)"], cwd: home, env: { PATH: process.env.PATH ?? "" } },
  { role: "harness", label: "surviving harness", signal: new AbortController().signal, home })
console.log(JSON.stringify({ pid: harness.pid }))
process.exit(0)
