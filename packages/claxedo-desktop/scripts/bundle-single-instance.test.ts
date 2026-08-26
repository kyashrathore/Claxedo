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

/**
 * ONE build, shared by both tests. A second `Bun.build` in the same process
 * fails with phantom `EISDIR reading file` / `Unexpected reading file` errors
 * on files that are also LOADED MODULES of the test process (reproduced
 * minimally on bun 1.3.14: import scripts/diagnostics-child-transport.ts —
 * which loads the workspace-runtime graph — then call `bundleClaxedoServer`
 * twice; the second build reports those errors on hono/jose/agent-* files the
 * first build read fine). Both tests inspect the same artifact anyway, so a
 * shared build is also strictly faster.
 */
let bundled: Promise<unknown> | undefined
function bundleOnce() {
  bundled ??= bundleClaxedoServer(path.resolve(import.meta.dir, "claxedo-server-boot.ts"), OUT)
  return bundled
}

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
  test("carries no hosted capability implementation", async () => {
    // The point of the split, measured on the artifact rather than the import
    // graph. Before the desktop entry moved to `@claxedo/local-server` this
    // bundle was 30MB and contained the Convex client, better-auth, the Polar
    // billing SDK and the Daytona driver — in a build that never signs in.
    //
    // Matched on symbols that only appear in the real implementations. Plain
    // words like "convex" or "workgraph" still occur as DATA — a network-policy
    // hostname allowlist, a route-ownership prefix table, an event-name switch
    // — and matching those would fail for the wrong reason.
    await bundleOnce()

    const text = emitted(OUT).map((file) => fs.readFileSync(file, "utf8")).join("\n")
    const forbidden = {
      "Convex client": /ConvexHttpClient|ConvexClient\b/,
      "better-auth": /betterAuth\(|better-auth\//,
      "Polar billing": /@polar-sh|PolarCore\b/,
      "Daytona driver": /@daytona\/sdk|DaytonaClient\b/,
    }

    expect(
      Object.entries(forbidden)
        .filter(([, pattern]) => pattern.test(text))
        .map(([name]) => name),
    ).toEqual([])
  }, 300_000)

  test("emits exactly one copy of each stateful shared module", async () => {
    await bundleOnce()

    // Each marker must appear once in its module's source and NOWHERE else in
    // the tree — a marker that also matches a log line or comment somewhere
    // reports a phantom duplicate. Zero occurrences fails too: a drifted marker
    // means this test is dead, not passing.
    const markers = {
      "workspace store": /service: *"workspace-store"/g,
      "claxedo database": /opening claxedo database/g,
      // Narrow enough to be unique: a log line elsewhere legitimately says
      // "no local workspace runtime configured", and matching that made this
      // report two copies of a module that is present once.
      "local runtime port": /call configureLocalWorkspaceRuntime from the composition/g,
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
