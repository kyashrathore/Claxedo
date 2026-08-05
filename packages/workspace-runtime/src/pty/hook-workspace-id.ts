/**
 * Which value goes in the terminal's `CLAXEDO_WORKSPACE_ID`.
 *
 * The agent hooks post this straight back to the runtime as
 * `GET /api/wr/hook/agent-lifecycle?workspaceId=…`, where it is resolved as a
 * workspace IDENTITY. A directory path in that slot does not resolve, and the
 * request 404s — silently, because `notify.sh` backgrounds its curl and
 * discards the response. The visible symptom is that a coding agent running in
 * a terminal never shows working/permission status, with nothing in any log.
 *
 * Measured against a live server:
 *   ?workspaceId=/Users/me/repo                        → 404
 *   ?workspaceId=0cce5b5d-1a52-4538-865d-fde31ca7653c  → 200 {"success":true}
 *
 * A path is therefore treated as absent rather than passed through: the PTY
 * layer used to fall back to `cwd`, and callers in this codebase have a
 * standing habit of handing directories where an identity is expected (the
 * directory-shape routing debt), so an explicit path-shaped value is far more
 * likely to be that mistake than a deliberate identity.
 */
export function terminalHookWorkspaceId(input: {
  envWorkspaceId?: string
  runtimeWorkspaceId: () => string
}): string {
  const explicit = input.envWorkspaceId?.trim()
  if (explicit && !looksLikeDirectoryPath(explicit)) return explicit
  return input.runtimeWorkspaceId()
}

/**
 * POSIX absolute paths, `~`-relative paths, and Windows drive/UNC paths. A
 * workspace identity is an opaque token (a UUID in practice) and never contains
 * a path separator, so this stays deliberately broad.
 */
export function looksLikeDirectoryPath(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("~")) return true
  if (value.startsWith("\\\\")) return true
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  return value.includes("/") || value.includes("\\")
}
