import { preferenceKey, persistedStore } from "@/lib/persisted"
import { isRecord } from "@/lib/record"
import type { ProjectId } from "@/server"

type StoredProject = { id: string }

type RailStore = {
  projects: StoredProject[]
  colors: Record<string, string>
}

function readStore(value: unknown): RailStore | undefined {
  if (!isRecord(value) || !Array.isArray(value.projects)) return undefined
  const projects = value.projects.flatMap((row) => (isRecord(row) && typeof row.id === "string" ? [{ id: row.id }] : []))
  const colors = isRecord(value.colors)
    ? Object.fromEntries(Object.entries(value.colors).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {}
  return { projects, colors }
}

function syncedOrder(current: readonly StoredProject[], ids: readonly string[]): StoredProject[] | undefined {
  const known = new Set(ids)
  const kept = current.filter((row) => known.has(row.id))
  const keptIds = new Set(kept.map((row) => row.id))
  const next = [...kept, ...ids.filter((id) => !keptIds.has(id)).map((id) => ({ id }))]
  const changed = next.length !== current.length || next.some((row, index) => row.id !== current[index]?.id)
  return changed ? next : undefined
}

export type ProjectState = ReturnType<typeof createProjectState>

export function createProjectState(server: string) {
  const [store, setStore] = persistedStore<RailStore>(preferenceKey("projects", server), { projects: [], colors: {} }, readStore)
  return {
    order: () => store.projects,
    colors: () => store.colors,
    setColor: (id: ProjectId, color: string) => setStore("colors", id, color),
    sync: (ids: readonly ProjectId[]) => {
      const next = syncedOrder(store.projects, ids)
      if (next) setStore("projects", next)
    },
  }
}
