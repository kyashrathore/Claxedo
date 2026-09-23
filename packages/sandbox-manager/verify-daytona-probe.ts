// Post-run cleanup state check. NOT for commit.
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const envFile = resolve(import.meta.dir, "../claxedo-server/.env")
const apiKey = readFileSync(envFile, "utf8").match(/^DAYTONA_API_KEY=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "")
if (!apiKey) throw new Error("DAYTONA_API_KEY missing")

const { Daytona } = await import("@daytona/sdk")
const sdk = new Daytona({ apiKey, _experimental: { otelEnabled: false } })

console.log("== sandboxes ==")
let n = 0
for await (const s of sdk.list()) {
  n++
  console.log(JSON.stringify({ id: s.id, name: s.name, state: s.state }))
}
if (n === 0) console.log("(none)")

console.log("== snapshots named claxedo-* ==")
const snaps = await sdk.snapshot.list({ page: 1, limit: 100 })
for (const snap of snaps.items ?? []) {
  if (!snap.name.startsWith("claxedo-")) continue
  console.log(JSON.stringify({ id: snap.id, name: snap.name, state: snap.state }))
  // Try delete by id and by name
  try {
    await sdk.snapshot.delete(snap.id)
    console.log("  deleted by id")
  } catch (e1) {
    console.log("  delete by id failed:", e1 instanceof Error ? e1.message : String(e1))
    try {
      await sdk.snapshot.delete(snap.name)
      console.log("  deleted by name")
    } catch (e2) {
      console.log("  delete by name failed:", e2 instanceof Error ? e2.message : String(e2))
    }
  }
}
