import path from "node:path"

export function dir(raw?: string): string | undefined {
  const txt = raw?.trim()
  if (!txt) return
  if (path.isAbsolute(txt) || /^[A-Za-z]:[\\/]/.test(txt)) return txt

  const hit = ["/Users/", "/private/", "/Volumes/", "/home/"]
    .map((item) => txt.indexOf(item))
    .filter((item) => item >= 0)
    .sort((a, b) => a - b)[0]

  if (hit !== undefined) return txt.slice(hit)
  if (/^(Users|private|Volumes|home)\//.test(txt)) return `/${txt}`
  return txt
}
