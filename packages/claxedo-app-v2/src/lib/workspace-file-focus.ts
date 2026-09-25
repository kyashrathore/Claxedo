export type WorkspaceFileFocusTarget = {
  path: string
  line?: number
  col?: number
}

export function resolveWorkspaceFileFocus(
  raw: string,
  workspaceDir: string,
): WorkspaceFileFocusTarget | undefined {
  let path = raw.trim()
  if (!path) return undefined

  let line: number | undefined
  let col: number | undefined
  const suffix = path.match(/:(\d+)(?::(\d+))?$/)
  if (suffix) {
    path = path.slice(0, -suffix[0].length)
    line = Number.parseInt(suffix[1], 10)
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
