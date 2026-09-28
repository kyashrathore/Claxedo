import { createHarnessServices } from "../harness-services"
import { migrateLaunchOwnership, sqliteLaunchOwnership } from "../ownership/launch-ownership-sqlite"
import { openDatabase } from "../store"

const [home, ledger] = process.argv.slice(2)
if (!home || !ledger) throw new Error("usage: home-runtime.ts <home> <launch-ledger>")
const db = openDatabase(ledger)
migrateLaunchOwnership(db)
const services = createHarnessServices({
  ownership: sqliteLaunchOwnership(db, { ownerGeneration: "home-runtime", scope: { kind: "standalone" } }),
  log: { debug() {}, info() {}, warn() {}, error() {} },
  clock: { now: Date.now, setTimeout, clearTimeout },
  patternEvaluator: async () => {},
  healthChanged: () => {},
})
await services.recordHomeUse(home)
const harness = await services.spawn({ file: "/bin/sleep", args: ["60"], cwd: home, env: { PATH: process.env.PATH ?? "" } },
  { role: "harness", label: "surviving harness", signal: new AbortController().signal, home })
console.log(JSON.stringify({ pid: harness.pid }))
process.exit(0)
