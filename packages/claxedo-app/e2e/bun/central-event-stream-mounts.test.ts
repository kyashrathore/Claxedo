import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * Contract binding for the central event stream's route spellings.
 *
 * `claxedo-local-server` mounts one handler (`streamGlobalEvents`) on several paths
 * because different readers open the same bus under different names: global-sdk's compat
 * loop opens `/global/event` (`/api/wr/events` for a signed document) and
 * `ClaxedoEventsProvider`'s central target opens `/api/claxedo/events`.
 *
 * A spec that hand-rolls its boot mock and routes only some of those spellings loses its
 * bus reader silently: the connection escapes to the real port and every emitted frame is
 * dropped with nothing failing at the seam. This test reads the mounts off the server
 * source so adding, renaming or removing a spelling fails here.
 */
const repoFile = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")

/** Every path `claxedo-local-server` answers the central bus on (`shell/routes.ts`). */
function centralStreamPaths() {
  const source = repoFile("../../../claxedo-local-server/src/shell/routes.ts")
  const paths = [...source.matchAll(/\.get\("([^"]+)",\s*\(c\)\s*=>\s*stream\(c\)\)/g)]
    .map((match) => match[1])
  return [...new Set(paths)]
}

/** Every path a spec registers a Playwright route glob for. */
function routedPaths(specSource: string) {
  return [...specSource.matchAll(/page\.route\(\s*"\*\*([^"]+?)\*?\*?"/g)].map((match) => match[1])
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
    // `process.crashed` is delivered by intercepting the app's first event-stream
    // connection, and `ProcessPaneProvider` reads it off `useClaxedoEvents`; if only
    // `/api/wr/events` is routed, global-sdk's compat loop claims that interception.
    const spec = repoFile("../playwright/core-processes.spec.ts")
    expect(routes(spec, "/api/claxedo/events")).toBe(true)
    expect(routes(spec, "/api/wr/events")).toBe(true)
  })
})
