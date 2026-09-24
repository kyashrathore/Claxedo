import { preferenceKey, persistedStore } from "@/lib/persisted"
import { isRecord, onlyStrings } from "@/lib/record"

export type StoredProject = { worktree: string; expanded: boolean }

type ProjectStore = {
  projects: StoredProject[]
  closed: string[]
  last?: string
  colors: Record<string, string>
}

export function validWorktree(input: string | undefined) {
  if (!input) return false
  const value = input.trim()
  if (!value) return false
  if (value.includes("\0")) return false
  if (value === "/" || value === "\\") return false
  if (value.length > 4096) return false
  const abs = value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")
  if (!abs) return false
  if (/^[A-Za-z]:[\\/]?$/.test(value)) return false
  if (/[\\/]\.{1,2}(?:[\\/]|$)/.test(value)) return false
  if (value === "/workspace") return false
  return true
}

export function validProjectRef(input: string | undefined) {
  if (!input) return false
  const value = input.trim()
  if (/^workspace:[^/\s]+$/.test(value)) return true
  return validWorktree(input)
}

function readStore(value: unknown): ProjectStore | undefined {
  if (!isRecord(value) || !Array.isArray(value.projects)) return undefined
  const projects = value.projects.flatMap((row) =>
    isRecord(row) && typeof row.worktree === "string" ? [{ worktree: row.worktree, expanded: row.expanded !== false }] : [],
  )
  const colors = isRecord(value.colors)
    ? Object.fromEntries(Object.entries(value.colors).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {}
  return { projects, closed: onlyStrings(value.closed), colors, ...(typeof value.last === "string" ? { last: value.last } : {}) }
}

function moved(current: readonly StoredProject[], directory: string, toIndex: number) {
  const fromIndex = current.findIndex((x) => x.worktree === directory)
  if (fromIndex === -1 || fromIndex === toIndex) return undefined
  const result = [...current]
  const [item] = result.splice(fromIndex, 1)
  if (item) result.splice(toIndex, 0, item)
  return result
}

function synced(current: readonly StoredProject[], directories: readonly string[]) {
  const expanded = new Map(current.map((x) => [x.worktree, x.expanded]))
  const seen = new Set<string>()
  return directories
    .filter(validProjectRef)
    .filter((worktree) => {
      if (seen.has(worktree)) return false
      seen.add(worktree)
      return true
    })
    .map((worktree) => ({ worktree, expanded: expanded.get(worktree) ?? true }))
}

export type ProjectState = ReturnType<typeof createProjectState>

export function createProjectState(server: string) {
  const [store, setStore] = persistedStore<ProjectStore>(preferenceKey("projects", server), { projects: [], closed: [], colors: {} }, readStore)
  const setExpanded = (directory: string, expanded: boolean) => {
    const index = store.projects.findIndex((x) => x.worktree === directory)
    if (validProjectRef(directory) && index !== -1) setStore("projects", index, "expanded", expanded)
  }
  return {
    list: () => store.projects,
    colors: () => store.colors,
    setColor: (worktree: string, color: string) => setStore("colors", worktree, color),
    open: (directory: string) => {
      if (!validProjectRef(directory)) return
      if (store.closed.includes(directory)) setStore("closed", store.closed.filter((x) => x !== directory))
      if (store.projects.find((x) => x.worktree === directory)) return
      setStore("projects", [{ worktree: directory, expanded: true }, ...store.projects])
    },
    close: (directory: string) => {
      if (!validProjectRef(directory)) return
      if (!store.closed.includes(directory)) setStore("closed", [...store.closed, directory])
      setStore("projects", store.projects.filter((x) => x.worktree !== directory))
    },
    remove: (directory: string) => {
      if (!validProjectRef(directory) || !store.projects.some((x) => x.worktree === directory)) return
      setStore("projects", store.projects.filter((x) => x.worktree !== directory))
    },
    isClosed: (directory: string) => validProjectRef(directory) && store.closed.includes(directory),
    sync: (directories: readonly string[]) => setStore("projects", synced(store.projects, directories)),
    expand: (directory: string) => setExpanded(directory, true),
    collapse: (directory: string) => setExpanded(directory, false),
    move: (directory: string, toIndex: number) => {
      const next = validProjectRef(directory) ? moved(store.projects, directory, toIndex) : undefined
      if (next) setStore("projects", next)
    },
    last: () => store.last,
    touch: (directory: string) => setStore("last", directory),
  }
}
