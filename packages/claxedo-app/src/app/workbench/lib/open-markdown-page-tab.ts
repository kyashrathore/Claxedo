function clean(value: unknown) {
  if (typeof value !== "string") return ""
  return value.trim()
}

function isPathLike(value: string) {
  if (!value) return false
  if (/^file:/i.test(value)) return true
  if (/^[a-z]:[\\/]/i.test(value)) return true
  if (/^[a-z][a-z\d+\-.]*:/i.test(value)) return false
  if (value.startsWith("//")) return false
  return true
}

function normalizePath(path: string) {
  const value = path.replaceAll("\\", "/")
  const absolute = value.startsWith("/")
  const out = value.split("/").reduce<string[]>((list, part) => {
    if (!part || part === ".") return list
    if (part === "..") return list.slice(0, -1)
    return [...list, part]
  }, [])
  const joined = out.join("/")
  return absolute ? `/${joined}` : joined
}

export function isMarkdownPath(path: string) {
  return /\.(?:md|markdown|mdown)$/i.test(clean(path))
}

export function markdownPathFromHref(raw: string) {
  const value = clean(raw)
  if (!isPathLike(value)) return ""
  const source = (() => {
    if (!/^file:/i.test(value)) return value
    try {
      return new URL(value).pathname || ""
    } catch {
      return value.replace(/^file:\/\/+/i, "/")
    }
  })()
  const [base] = source.split("#", 1)
  const [path] = base.split("?", 1)
  const decoded = (() => {
    try {
      return clean(decodeURIComponent(path))
    } catch {
      return clean(path)
    }
  })()
  if (!isMarkdownPath(decoded)) return ""
  return normalizePath(decoded)
}
