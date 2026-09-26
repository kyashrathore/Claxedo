import { getFilename } from "@/ui/utils"

export type FolderRow = {
  absolute: string
  search: string
  group: "recent" | "folders"
}

export function cleanInput(value: string) {
  return ((value ?? "").split(/\r?\n/)[0] ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim()
}

function normalizePath(input: string) {
  const v = input.replaceAll("\\", "/")
  if (v.startsWith("//") && !v.startsWith("///")) return "//" + v.slice(2).replace(/\/+/g, "/")
  return v.replace(/\/+/g, "/")
}

export function normalizeDriveRoot(input: string) {
  const v = normalizePath(input)
  if (/^[A-Za-z]:$/.test(v)) return v + "/"
  return v
}

export function trimTrailing(input: string) {
  const v = normalizeDriveRoot(input)
  if (v === "/" || v === "//" || /^[A-Za-z]:\/$/.test(v)) return v
  return v.replace(/\/+$/, "")
}

export function joinPath(base: string | undefined, rel: string) {
  const b = trimTrailing(base ?? "")
  const r = trimTrailing(rel).replace(/^\/+/, "")
  if (!b) return r
  if (!r) return b
  return b.endsWith("/") ? b + r : b + "/" + r
}

export function rootOf(input: string) {
  const v = normalizeDriveRoot(input)
  if (v.startsWith("//")) return "//"
  if (v.startsWith("/")) return "/"
  if (/^[A-Za-z]:\//.test(v)) return v.slice(0, 3)
  return ""
}

export function parentOf(input: string) {
  const v = trimTrailing(input)
  if (v === "/" || v === "//" || /^[A-Za-z]:\/$/.test(v)) return v
  const i = v.lastIndexOf("/")
  if (i <= 0) return "/"
  if (i === 2 && /^[A-Za-z]:/.test(v)) return v.slice(0, 3)
  return v.slice(0, i)
}

function modeOf(input: string) {
  const raw = normalizeDriveRoot(input.trim())
  if (!raw) return "relative"
  if (raw.startsWith("~")) return "tilde"
  if (rootOf(raw)) return "absolute"
  return "relative"
}

function tildeOf(absolute: string, home: string) {
  const full = trimTrailing(absolute)
  if (!home) return ""
  const hn = trimTrailing(home)
  const lc = full.toLowerCase()
  const hc = hn.toLowerCase()
  if (lc === hc) return "~"
  if (lc.startsWith(hc + "/")) return "~" + full.slice(hn.length)
  return ""
}

export function displayPath(path: string, input: string, home: string) {
  const full = trimTrailing(path)
  if (modeOf(input) === "absolute") return full
  return tildeOf(full, home) || full
}

export function toRow(absolute: string, home: string, group: FolderRow["group"]): FolderRow {
  const full = trimTrailing(absolute)
  const tilde = tildeOf(full, home)
  const withSlash = (value: string) => value && !value.endsWith("/") ? value + "/" : value
  return {
    absolute: full,
    search: Array.from(new Set([full, withSlash(full), tilde, withSlash(tilde), getFilename(full)].filter(Boolean))).join("\n"),
    group,
  }
}

export function uniqueRows(rows: FolderRow[]) {
  const seen = new Set<string>()
  return rows.filter((row) => {
    if (seen.has(row.absolute)) return false
    seen.add(row.absolute)
    return true
  })
}
