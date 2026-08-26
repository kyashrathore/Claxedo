/**
 * Shared normalization + containment for "open this path as a workspace file
 * tab" requests coming from terminal file links and session-timeline path
 * chips. Both entry points previously hand-rolled slightly different guards,
 * which let `~/...`, `../...` and `path:42` strings through to the file panel
 * where they produced silently blank tabs (the server answers empty content
 * for nonexistent paths instead of erroring).
 */
export type WorkspaceFileFocusTarget = {
  /** Workspace-relative path (never absolute, never traversal). */
  path: string
  line?: number
  col?: number
}

/**
 * Resolve a raw path string into a workspace-relative file-focus target.
 * Returns undefined when the path cannot be opened in the panel:
 *  - `~/...` (cannot be expanded client-side; resolving it under the
 *    workspace root would open a wrong, blank file)
 *  - absolute paths outside the workspace
 *  - `..` traversal segments (cannot be resolved reliably client-side)
 *  - the workspace directory itself (a directory, not a file)
 *
 * A trailing `:line[:col]` suffix is parsed off and returned separately so
 * chips like `src/foo.ts:42` open `src/foo.ts` instead of requesting the
 * literal path `src/foo.ts:42`.
 */
export function resolveWorkspaceFileFocus(raw: string, workspaceDir: string): WorkspaceFileFocusTarget | undefined {
  let path = raw.trim()
  if (!path) return undefined

  let line: number | undefined
  let col: number | undefined
  const suffix = path.match(/:(\d+)(?::(\d+))?$/)
  if (suffix) {
    path = path.slice(0, -suffix[0].length)
    line = Number.parseInt(suffix[1]!, 10)
    if (suffix[2]) col = Number.parseInt(suffix[2], 10)
  }

  if (path.startsWith("~")) return undefined

  const dir = workspaceDir.replace(/\/+$/, "")
  if (path.startsWith("/")) {
    if (!dir) return undefined
    if (path === dir) return undefined
    if (!path.startsWith(`${dir}/`)) return undefined
    path = path.slice(dir.length + 1)
  }

  path = path.replace(/^\.\//, "")
  if (!path) return undefined
  if (path.split("/").some((segment) => segment === "..")) return undefined

  return { path, line, col }
}
