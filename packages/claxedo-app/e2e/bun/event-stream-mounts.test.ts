import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * Contract binding for the two event streams' route spellings.
 *
 * The local daemon serves the control plane's notices on exactly one path
 * (`/api/cp/events`, `shell/routes.ts`) and a workspace runtime serves its
 * frames on exactly one (`/api/wr/events`, `workspace-runtime/src/workspace/core.ts`
 * through its route manifest).
 * A spec that hand-rolls its boot mock and routes a different spelling loses
 * its reader silently: the connection escapes to the real port and every
 * emitted frame is dropped with nothing failing at the seam. This test reads
 * the mounts off the server sources so a rename fails here.
 */
const repoFile = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")

/** Every path `claxedo-local-server` streams on (`shell/routes.ts`). */
function controlPlaneStreamPaths() {
  const source = repoFile("../../../claxedo-local-server/src/shell/routes.ts")
  return [...new Set([...source.matchAll(/\.get\("([^"]+)",\s*\(c\)\s*=>\s*stream\(c\)\)/g)].map((match) => match[1]))]
}

/** The one path a workspace runtime mounts its events handler on (`workspace/core.ts`, from the route manifest). */
function workspaceStreamPaths() {
  const mounts = repoFile("../../../workspace-runtime/src/workspace/core.ts")
  const manifest = repoFile("../../../workspace-runtime/src/routes/manifest.ts")
  const prefix = manifest.match(/WorkspaceRuntimeApiPrefix = "([^"]+)"/)?.[1]
  const handlers = [...mounts.matchAll(/const (\w+) = workspaceEventsHandler\(/g)].map((match) => match[1])
  const keys = [...mounts.matchAll(/app\.get\(WorkspaceRuntimeRoutes\.(\w+),\s*(\w+)\)/g)]
    .filter((match) => handlers.includes(match[2]))
    .map((match) => match[1])
  return keys.map((key) => {
    const suffix = manifest.match(new RegExp(`\\b${key}: \`\\$\\{WorkspaceRuntimeApiPrefix\\}([^\`]*)\``))?.[1]
    return `${prefix}${suffix}`
  })
}

/** Every path a spec registers a Playwright route or WebSocket route glob for. */
function routedPaths(specSource: string) {
  return [...specSource.matchAll(/page\.route(?:WebSocket)?\(\s*"\*\*([^"]+?)\*?\*?"/g)].map((match) => match[1])
}

function routes(specSource: string, path: string) {
  return routedPaths(specSource).some((routed) => routed.replace(/\?$/, "") === path)
}

describe("event stream mounts", () => {
  test("each server streams on exactly one path", () => {
    expect(controlPlaneStreamPaths()).toEqual(["/api/cp/events"])
    expect(workspaceStreamPaths()).toEqual(["/api/wr/events"])
  })

  test("core-terminal's hand-rolled boot mock serves both", () => {
    const spec = repoFile("../playwright/core-terminal.spec.ts")
    for (const path of [...controlPlaneStreamPaths(), ...workspaceStreamPaths()]) {
      expect({ path, routed: routes(spec, path) }).toEqual({ path, routed: true })
    }
  })

  test("core-processes' crash injection reaches the workspace stream the provider reads", () => {
    // `process.crashed` is a workspace control frame, delivered by intercepting
    // the app's first `wr/events` connection.
    const spec = repoFile("../playwright/core-processes.spec.ts")
    expect(routes(spec, "/api/wr/events")).toBe(true)
  })
})
