export type WorkspaceFileFocusTarget = {
  path: string
  line?: number
  col?: number
}

export function splitFileLineSuffix(raw: string): WorkspaceFileFocusTarget {
  const path = raw.trim()
  const suffix = path.match(/:(\d+)(?::(\d+))?$/)
  if (!suffix) return { path }
  return {
    path: path.slice(0, -suffix[0].length),
    line: Number.parseInt(suffix[1], 10),
    col: suffix[2] ? Number.parseInt(suffix[2], 10) : undefined,
  }
}

export function resolveWorkspaceFileFocus(
  raw: string,
  workspaceDir: string,
): WorkspaceFileFocusTarget | undefined {
  const { line, col, ...target } = splitFileLineSuffix(raw)
  let path = target.path

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
