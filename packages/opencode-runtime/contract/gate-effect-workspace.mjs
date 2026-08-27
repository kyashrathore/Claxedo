/**
 * Tests the setup the SDK's OWN tests use, which I had not been doing.
 *
 * Reading upstream `packages/sdk/test/embedded.test.ts` shows a working prompt
 * needs three things:
 *
 *   1. `workspaceProviders: { <name>: driver }` — a registered workspace driver
 *   2. `workspace.create({ provider })` then `workspace.provision({ workspaceID })`
 *   3. sessions created with `location: { directory, workspaceID }`
 *
 * The promise entrypoint CANNOT do step 1: `packages/sdk/src/promise.ts:8`
 * declares `CreateOptions extends Omit<EmbeddedHost.CreateOptions,
 * "workspaceProviders">`. The Effect entrypoint can —
 * `packages/sdk/src/effect/opencode.ts` declares
 * `export type CreateOptions = EmbeddedHost.CreateOptions`, unomitted, and also
 * exposes `workspace.provision`.
 *
 * `@opencode-ai/sdk/effect` is a documented public export, so this is not a
 * Decision 15 violation.
 *
 *   bun run gate-effect-workspace.mjs
 */
import { OpenCode } from "@opencode-ai/sdk/effect"
import { WorkspaceDriver } from "@opencode-ai/core/workspace/driver"
import { EnvironmentLocal } from "@opencode-ai/core/environment/local"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as util from "node:util"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-effect-"))
// Location.layer calls project.resolve(directory), so project resolution may
// need a real git-backed project rather than a bare temp directory.
const workspaceDir = process.env.PROBE_DIR ?? path.join(root, "ws")
if (!process.env.PROBE_DIR) {
  fs.mkdirSync(workspaceDir)
  fs.writeFileSync(path.join(workspaceDir, "README.md"), "# probe\n")
}
console.log("workspace directory:", workspaceDir)

/** A local workspace driver: connect hands back the host filesystem driver. */
const localDriver = WorkspaceDriver.make({
  create: ({ workspaceID }) => Effect.succeed({ binding: { externalID: workspaceID } }),
  connect: () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner
      return EnvironmentLocal.makeLocalDriver(spawner)
    }),
  suspendForIdle: () => Effect.void,
  destroy: () => Effect.void,
})

const program = Effect.gen(function* () {
  const oc = yield* OpenCode.create({
    database: { path: path.join(root, "c.db") },
    workspaceProviders: { local: localDriver },
  })
  console.log("host created via the Effect entrypoint")

  const workspaceID = yield* oc.workspace.create({ provider: "local" })
  console.log("workspace.create OK", workspaceID)

  const workspace = yield* oc.workspace.provision({ workspaceID })
  console.log("workspace.provision OK", JSON.stringify(workspace).slice(0, 160))

  // effect 4 renamed catchAll; `match` handles both channels in one step.
  const attempt = (label, effect) =>
    effect.pipe(
      Effect.match({
        onSuccess: (value) => console.log(`  OK  ${label}`, JSON.stringify(value).slice(0, 200)),
        onFailure: (error) => error,
      }),
      Effect.flatMap((outcome) => {
        if (typeof outcome === "string") return Effect.void
        const response = outcome?.cause?.reason?.response
        const status = response?.status ?? "?"
        // response.text is an EFFECT, not a string. Printing it raw yields
        // { _id: "Effect", op: "Suspend" }, which looks like a broken server
        // error path but is just an unevaluated accessor. Run it.
        const text = response?.text
        console.log(`  ERR ${label} status=${status}`)
        if (!text || typeof text.pipe !== "function") return Effect.void
        return text.pipe(
          Effect.match({
            onSuccess: (value) => console.log("        body:", String(value).slice(0, 600)),
            onFailure: (readError) => console.log("        body unreadable:", String(readError).slice(0, 200)),
          }),
        )
      }),
    )

  // Sessions now carry the provisioned workspaceID, not just a bare directory.
  const session = yield* oc.sessions.create({ location: { directory: workspaceDir, workspaceID } })
  console.log("session", session.id)

  console.log("\nthe surfaces that 500'd through the promise entrypoint:")
  yield* attempt("config.get   ", oc.config.get({ location: { directory: workspaceDir, workspaceID } }))
  yield* attempt("agent.list   ", oc.agent.list({ location: { directory: workspaceDir, workspaceID } }))
  yield* attempt("provider.list", oc.provider.list({ location: { directory: workspaceDir, workspaceID } }))

  console.log("\nand execution:")
  yield* attempt("sessions.prompt", oc.sessions.prompt({ sessionID: session.id, text: "say hi" }))
})

await Effect.runPromise(Effect.scoped(program)).catch((error) => {
  console.log("PROGRAM FAILED", util.inspect(error, { depth: 4 }).slice(0, 1200))
})

fs.rmSync(root, { recursive: true, force: true })
