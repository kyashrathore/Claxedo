import { requireWorkspaceDirectory } from "../target"

/**
 * A workspace directory spelled the way the runtime keys it. Every adapter
 * entry point resolves the directory it is handed, so a test that binds a
 * store row under the literal `/work` and then asks through the adapter reads
 * `/work` on POSIX but `D:\work` on Windows, and finds nothing.
 */
export function workspaceDirectory(name: string) {
  return requireWorkspaceDirectory(`/${name}`)
}
