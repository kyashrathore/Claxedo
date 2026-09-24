export type FileLinkTarget = {
  readonly path: string
  readonly line?: number
  readonly col?: number
}

function relativeTo(path: string, cwd: string | undefined): string | undefined {
  if (!path.startsWith("/")) return path
  const root = (cwd ?? "").replace(/\/+$/, "")
  if (!root || path === root || !path.startsWith(`${root}/`)) return undefined
  return path.slice(root.length + 1)
}

export function fileLinkTarget(raw: string, cwd: string | undefined, line?: number, col?: number): FileLinkTarget | undefined {
  let path = raw.trim()
  if (!path || path.startsWith("~")) return undefined
  const suffix = path.match(/:(\d+)(?::(\d+))?$/)
  if (suffix) {
    path = path.slice(0, -suffix[0].length)
    line ??= Number.parseInt(suffix[1], 10)
    if (suffix[2]) col ??= Number.parseInt(suffix[2], 10)
  }
  const relative = relativeTo(path, cwd)
  if (relative === undefined) return undefined
  const normalized = relative.replace(/^\.\//, "")
  if (!normalized || normalized.split("/").some((segment) => segment === "..")) return undefined
  return { path: normalized, ...(line === undefined ? {} : { line }), ...(col === undefined ? {} : { col }) }
}
