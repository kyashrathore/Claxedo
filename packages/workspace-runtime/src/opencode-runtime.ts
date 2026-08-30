import fs from "node:fs"
import path from "node:path"
import { createOpenCodeRuntime, type OpenCodeRuntime } from "@claxedo/opencode-runtime"

/**
 * Compose the SDK owner for a standalone workspace-runtime process.
 *
 * The database is a peer of the runtime's existing workspace-owned state. A
 * standalone host owns this object and closes it during process drain; an
 * embedded host injects its process-wide owner instead.
 */
export function createWorkspaceOpenCodeRuntime(directory: string): OpenCodeRuntime {
  const root = path.join(path.resolve(directory), ".claxedo", "opencode-runtime")
  fs.mkdirSync(root, { recursive: true })
  return createOpenCodeRuntime({ databasePath: path.join(root, "opencode.db"), persistEvents: true })
}
