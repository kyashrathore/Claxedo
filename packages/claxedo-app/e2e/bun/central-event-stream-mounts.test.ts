import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * CONTRACT BINDING: the central event stream's route spellings.
 *
 * `claxedo-local-server` mounts ONE handler (`streamGlobalEvents`) on several
 * paths, and the hosted server does the same, because different app readers
 * open the same bus under different names: global-sdk's compat loop opens
 * `/global/event` (rewritten to `/api/wr/events` for a signed document), while
 * `ClaxedoEventsProvider`'s CENTRAL target opens `controlPlaneEventsUrl` ->
 * `/api/claxedo/events`.
 *
 * `core-terminal.spec.ts` hand-rolls its own boot mock instead of using
 * `installMockRuntime`, and it mounted its Claxedo event bus on
 * `/api/wr/events` alone. When the provider's central target moved to
 * `/api/claxedo/events`, that spec's bus lost its only reader: the connection
 * escaped to 127.0.0.1:3001 and every `emitClaxedoEvent` frame was silently
 * dropped, taking five terminal status/title behaviours red with no signal
 * pointing at the mock. Nothing failed at the seam that actually broke.
 *
 * This test is that signal. It reads the mounts off the REAL server source, so
 * adding, renaming or removing a central spelling there fails here instead of
 * quietly starving a spec's event bus.
 */
const repoFile = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")

/** Every path `claxedo-local-server` answers the central bus on. */
function centralStreamPaths() {
  const source = repoFile("../../../claxedo-local-server/src/opencode/compat-routes/index.ts")
  const paths = [...source.matchAll(/\.get\("([^"]+)",\s*\(c\)\s*=>\s*streamGlobalEvents\(c\)\)/g)]
    .map((match) => match[1]!)
  return [...new Set(paths)]
}

/** Every path a spec registers a Playwright route glob for. */
function routedPaths(specSource: string) {
  return [...specSource.matchAll(/page\.route\(\s*"\*\*([^"]+?)\*?\*?"/g)].map((match) => match[1]!)
}

function routes(specSource: string, path: string) {
  return routedPaths(specSource).some((routed) => routed.replace(/\?$/, "") === path)
}

describe("central event stream mounts", () => {
  test("the local server really does answer one bus under several names", () => {
    const paths = centralStreamPaths()
    // If this shrinks to one spelling the whole aliasing problem is gone and
    // the spec assertions below become trivially true — so pin the shape.
    expect(paths).toContain("/api/claxedo/events")
    expect(paths).toContain("/api/wr/events")
    expect(paths).toContain("/global/event")
  })

  test("core-terminal's hand-rolled boot mock serves every one of them", () => {
    const spec = repoFile("../playwright/core-terminal.spec.ts")
    for (const path of centralStreamPaths()) {
      expect({ path, routed: routes(spec, path) }).toEqual({ path, routed: true })
    }
  })

  test("core-processes' crash injection reaches the provider's central target", () => {
    // Behaviour 19 delivers `process.crashed` by intercepting the app's first
    // event-stream connection. `ProcessPaneProvider` reads it off
    // `useClaxedoEvents`, so the interception has to cover the central
    // spelling as well as the workspace-scoped one — pinning only
    // `/api/wr/events` let global-sdk's compat loop claim the single
    // interception and the process pane never learned about the crash.
    const spec = repoFile("../playwright/core-processes.spec.ts")
    expect(routes(spec, "/api/claxedo/events")).toBe(true)
    expect(routes(spec, "/api/wr/events")).toBe(true)
  })
})
