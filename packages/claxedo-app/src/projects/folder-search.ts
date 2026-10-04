import { getFilename } from "@/ui/utils"
import type { Server } from "@/server"
import { cleanInput, joinPath, normalizeDriveRoot, parentOf, rootOf, trimTrailing } from "./folder-paths"

type Scoped = { readonly directory: string; readonly path: string }

type Entry = { readonly name: string; readonly absolute: string }

type SearchInput = {
  readonly server: Server
  readonly start: () => string | undefined
  readonly home: () => string
}

type Search = SearchInput & { readonly browsable: () => Promise<boolean> }

function logged<T>(what: string, context: Readonly<Record<string, string>>, fallback: T) {
  return (error: unknown): T => {
    console.error(`Folder ${what} failed`, { ...context, error })
    return fallback
  }
}

function scopedInput(search: Search, value: string): Scoped | undefined {
  const raw = normalizeDriveRoot(value)
  const root = rootOf(raw)
  if (root) return { directory: trimTrailing(root), path: raw.slice(root.length) }
  const base = search.start()
  if (!base) return undefined
  if (!raw) return { directory: trimTrailing(base), path: "" }
  const home = search.home()
  if (raw === "~") return { directory: trimTrailing(home || base), path: "" }
  if (raw.startsWith("~/")) return { directory: trimTrailing(home || base), path: raw.slice(2) }
  return { directory: trimTrailing(base), path: raw }
}

async function folderChildren(search: Search, dir: string): Promise<Entry[]> {
  const key = trimTrailing(dir)
  if (!(await search.browsable())) return []
  const { queryClient, queries } = search.server
  return queryClient
    .fetchQuery({ ...queries.folders.children(key), staleTime: Number.POSITIVE_INFINITY })
    .then((entries) => entries.map((entry) => ({ name: entry.name, absolute: trimTrailing(normalizeDriveRoot(entry.absolute)) })))
    .catch(logged<Entry[]>("listing", { directory: key }, []))
}

async function matchingFolders(search: Search, dir: string, query: string, limit: number) {
  const items = await folderChildren(search, dir)
  if (!query) return items.slice(0, limit).map((x) => x.absolute)
  const needle = query.toLowerCase()
  return items
    .filter((item) => item.name.toLowerCase().includes(needle))
    .slice(0, limit)
    .map((x) => x.absolute)
}

async function find(search: Search, scoped: Scoped, query: string, active: () => boolean) {
  if (!(await search.browsable())) return []
  const results = await search.server.folders
    .search(scoped.directory, query, 50)
    .catch(logged<readonly string[]>("search", { directory: scoped.directory, query }, []))
  if (!active()) return []
  return results.map((rel) => joinPath(scoped.directory, rel)).slice(0, 50)
}

async function walkHead(search: Search, scoped: Scoped, head: readonly string[], active: () => boolean) {
  let paths = [scoped.directory]
  for (const part of head) {
    if (!active()) return undefined
    if (part === "..") {
      paths = paths.map(parentOf)
      continue
    }
    paths = Array.from(new Set((await Promise.all(paths.map((p) => matchingFolders(search, p, part, 4)))).flat())).slice(0, 12)
    if (paths.length === 0) return undefined
  }
  return paths
}

async function walk(search: Search, scoped: Scoped, query: string, raw: string, active: () => boolean) {
  const segments = query.replace(/^\/+/, "").split("/")
  const head = segments.slice(0, segments.length - 1).filter((x) => x && x !== ".")
  const tail = segments[segments.length - 1] ?? ""
  const paths = await walkHead(search, scoped, head, active)
  if (!paths) return []
  const out = (await Promise.all(paths.map((p) => matchingFolders(search, p, tail, 50)))).flat()
  if (!active()) return []
  const deduped = Array.from(new Set(out))
  const base = raw.startsWith("~") ? trimTrailing(scoped.directory) : ""
  if (raw.endsWith("/") || !tail) return (base ? Array.from(new Set([base, ...deduped])) : deduped).slice(0, 50)
  const target = deduped.find((p) => getFilename(p).toLowerCase() === tail.toLowerCase())
  if (!target) return deduped.slice(0, 50)
  const nested = await matchingFolders(search, target, "", 30)
  if (!active()) return []
  return (base ? Array.from(new Set([base, ...deduped, ...nested])) : Array.from(new Set([...deduped, ...nested]))).slice(0, 50)
}

export function createFolderSearch(input: SearchInput): (filter: string) => Promise<string[]> {
  let current = 0
  let allowed: Promise<boolean> | undefined
  const browsable = () => (allowed ??= input.server.folders.browsable().catch(logged("browsing check", {}, false)))
  const search: Search = { ...input, browsable }
  return async (filter) => {
    const token = ++current
    const active = () => token === current
    const value = cleanInput(filter)
    const scoped = scopedInput(search, value)
    if (!scoped) return []
    const raw = normalizeDriveRoot(value)
    const isPath = raw.startsWith("~") || !!rootOf(raw) || raw.includes("/")
    const query = normalizeDriveRoot(scoped.path)
    return isPath ? walk(search, scoped, query, raw, active) : find(search, scoped, query, active)
  }
}
