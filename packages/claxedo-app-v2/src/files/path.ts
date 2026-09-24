import type { FileFocusTarget } from "./model"

export function stripFileProtocol(input: string): string {
  return input.startsWith("file://") ? input.slice("file://".length) : input
}

export function basename(path: string): string {
  const index = path.lastIndexOf("/")
  return index === -1 ? path : path.slice(index + 1)
}

export function parentPath(path: string): string {
  const index = path.lastIndexOf("/")
  return index === -1 ? "" : path.slice(0, index)
}

function splitLineSuffix(raw: string): { readonly path: string; readonly line?: number; readonly col?: number } {
  const suffix = raw.match(/:(\d+)(?::(\d+))?$/)
  if (!suffix) return { path: raw }
  const line = Number.parseInt(suffix[1], 10)
  const col = suffix[2] ? Number.parseInt(suffix[2], 10) : undefined
  return { path: raw.slice(0, -suffix[0].length), line, ...(col === undefined ? {} : { col }) }
}

function relativeToRoot(path: string, root: string | undefined): string | undefined {
  if (!path.startsWith("/")) return path
  const dir = root?.replace(/\/+$/, "")
  if (!dir || path === dir || !path.startsWith(`${dir}/`)) return undefined
  return path.slice(dir.length + 1)
}

export function resolveFileFocus(raw: string, root?: string): FileFocusTarget | undefined {
  const trimmed = stripFileProtocol(raw.trim())
  if (!trimmed || trimmed.startsWith("~")) return undefined
  const { path: withoutSuffix, line, col } = splitLineSuffix(trimmed)
  const relative = relativeToRoot(withoutSuffix.replaceAll("\\", "/"), root)
  if (relative === undefined) return undefined
  const path = relative.replace(/^\.\//, "")
  if (!path || path.split("/").some((segment) => segment === "..")) return undefined
  return { path, ...(line === undefined ? {} : { line }), ...(col === undefined ? {} : { col }) }
}
