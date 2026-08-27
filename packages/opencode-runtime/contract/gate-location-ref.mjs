/**
 * Isolates the last usage variable: schema-constructed location vs plain object.
 *
 * Upstream's passing tests build the location with
 * `Location.Ref.make({ directory: AbsolutePath.make(dir) })` — schema
 * constructors, not object literals. Every probe of mine passed a plain
 * `{ directory }`. If the constructor is what makes it work, the 500s were my
 * usage all along and the SDK is fine.
 *
 * Runs against the PUBLISHED package in this isolated install, via the Effect
 * entrypoint, so the only thing changing is how the location is built.
 *
 *   bun run gate-location-ref.mjs
 */
import { OpenCode, Location, AbsolutePath } from "@opencode-ai/sdk/effect"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-locref-"))
const dir = path.join(root, "ws")
fs.mkdirSync(dir)
fs.writeFileSync(path.join(dir, "README.md"), "# probe\n")

console.log("Location export:", typeof Location, "| AbsolutePath:", typeof AbsolutePath)

const program = Effect.gen(function* () {
  const oc = yield* OpenCode.create()

  const report = (label, effect) =>
    effect.pipe(
      Effect.match({
        onSuccess: (value) => console.log(`  OK  ${label}`, JSON.stringify(value).slice(0, 120)),
        onFailure: (error) => console.log(`  ERR ${label}`, JSON.stringify(error).slice(0, 220)),
      }),
    )

  console.log("\nplain object location:")
  yield* report("config.get", oc.config.get({ location: { directory: dir } }))

  console.log("\nschema-constructed location (what upstream tests use):")
  const location = Location.Ref.make({ directory: AbsolutePath.make(dir) })
  yield* report("config.get", oc.config.get({ location }))
  yield* report("agent.list", oc.agent.list({ location }))
  yield* report("provider.list", oc.provider.list({ location }))
})

await Effect.runPromise(Effect.scoped(program)).catch((error) =>
  console.log("PROGRAM FAILED", String(error).slice(0, 500)),
)

fs.rmSync(root, { recursive: true, force: true })
