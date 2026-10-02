import os from "node:os"
import path from "node:path"
import { realDirectoryPath, realPathAllowingMissing } from "@claxedo/helpers/real-path"
import { inside } from "@claxedo/helpers/path"
import type { RuntimeBus } from "../bus"
import { createSessionCore, type SessionCore } from "../core"
import type { SessionPlacement } from "../placement"
import type { RuntimeEventHub } from "../projection/runtime-event-hub"

/**
 * A core's machine routes (Git, files, terminals, worktrees) act on the
 * directory it is rooted at, so a test core rooted in a checkout commits,
 * writes and amends there. Only a root under the OS temp directory is served.
 */
export function testSessionCore(directory: string, workspaceId = "ws_test", eventHub?: RuntimeEventHub): SessionCore {
  const root = path.resolve(directory)
  const temp = realDirectoryPath(os.tmpdir())
  if (!inside(temp, realPathAllowingMissing(root))) {
    throw new Error(`testSessionCore refuses ${root}: a test core is rooted under ${temp}, never in a checkout`)
  }
  return createSessionCore({ eventHub, placement: {
    workspaceId, directory: root, normalizeDirectory: (directory) => path.resolve(directory.trim()), canonicalDirectory: realDirectoryPath,
    containsDirectory: inside, sessionIdWorkspace: () => undefined,
  } })
}

/** The root `testSessionRoutePorts` serves; never created, since session routes alone touch no files. */
export const TEST_SESSION_ROUTES_DIRECTORY = path.join(os.tmpdir(), "claxedo-test-session-routes")

export function testSessionRoutePorts(bus?: RuntimeBus): { bus: RuntimeBus; placement: SessionPlacement } {
  const core = testSessionCore(TEST_SESSION_ROUTES_DIRECTORY)
  return { bus: bus ?? core.bus, placement: core.placement }
}
