import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { bundleClaxedoServer } from "./bundle-claxedo-server"

/**
 * The server the desktop ships must contain ONE copy of each stateful module.
 *
 * The 2026-08 package split moved the workspace store, the database singleton,
 * and the event bus into `@claxedo/server-core`, which is symlinked into
 * `node_modules` and whose exports map points at source. That means a module can
 * be reached by two different absolute paths — its own relative import from
 * inside the core, and the package specifier from outside — and a bundler that
 * keys on path rather than realpath will emit it twice.
 *
 * Two copies of the workspace store is not a size problem. It is a correctness
 * one: a workspace registered through one instance is invisible to the other,
 * and the symptom is a route answering "not found" for something that plainly
 * exists.
 *
 * This builds the real desktop entry with the real bundler, which is the only
 * thing that can answer the question — vitest and `bun test` each resolve
 * differently, so a green unit suite says nothing about the shipped artifact.
 */

const OUT = path.join(os.tmpdir(), `claxedo-bundle-instance-${process.pid}`)

afterAll(() => {
  fs.rmSync(OUT, { recursive: true, force: true })
})

/** Every emitted JS file, entry and chunks alike. */
function emitted(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return emitted(full)
    return entry.name.endsWith(".js") ? [full] : []
  })
}

describe("shipped claxedo-server bundle", () => {
  test("emits exactly one copy of each stateful shared module", async () => {
    await bundleClaxedoServer(path.resolve(import.meta.dir, "claxedo-server-entry.ts"), OUT)

    // Each marker is a string that appears once in its module's source and
    // nowhere else, so a second occurrence in the output means a second copy of
    // the module — not a second call site.
    const markers = {
      "workspace store": /service: *"workspace-store"/g,
      "claxedo database": /opening claxedo database/g,
      "local runtime port": /no local workspace runtime configured/g,
    }

    const counts = Object.fromEntries(
      Object.entries(markers).map(([name, pattern]) => [
        name,
        emitted(OUT).reduce(
          (total, file) => total + (fs.readFileSync(file, "utf8").match(pattern)?.length ?? 0),
          0,
        ),
      ]),
    )

    for (const [name, count] of Object.entries(counts)) {
      // Zero means the marker drifted and this test is dead, not passing.
      expect(count, `${name}: expected exactly one copy in the bundle`).toBe(1)
    }
  }, 300_000)
})
