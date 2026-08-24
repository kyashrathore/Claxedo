import { useShellQueryOptions as useQueryOptions } from "@/app/integrations/sync/query-options"

export type ProjectInventoryQueryOptions = ReturnType<ReturnType<typeof useQueryOptions>["projects"]>
export type ProjectInventoryStorage = {
  getItem: (key: string) => string | null
  removeItem?: (key: string) => void
}

type ProjectInventoryQueryCache<T> = {
  read: () => T[] | undefined
  write: (value: T[]) => unknown
}

const LEGACY_PROJECT_INVENTORY_STORAGE_KEY = "opencode.global.dat:globalSync.project"

export type ProjectInventorySource = {
  projects: () => ProjectInventoryQueryOptions
}

export function projectInventoryQuery(input: { source: ProjectInventorySource }) {
  return input.source.projects()
}

export function projectInventoryQueryKey(input: { source: ProjectInventorySource }) {
  return projectInventoryQuery(input).queryKey
}

function readLegacyProjectInventory<T = unknown>(storage?: ProjectInventoryStorage) {
  const source = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage)
  if (!source) return [] as T[]
  try {
    const parsed = JSON.parse(source.getItem(LEGACY_PROJECT_INVENTORY_STORAGE_KEY) ?? "null") as { value?: unknown }
    return Array.isArray(parsed?.value) ? (parsed.value as T[]) : []
  } catch {
    return [] as T[]
  }
}

export function migrateLegacyProjectInventoryToQueryCache<T>(input: {
  cache: ProjectInventoryQueryCache<T>
  storage?: ProjectInventoryStorage
  sanitize?: (project: T) => T
}) {
  const source = input.storage ?? (typeof localStorage === "undefined" ? undefined : localStorage)
  const raw = source?.getItem(LEGACY_PROJECT_INVENTORY_STORAGE_KEY)
  if (!source || raw === null) return []

  const legacy = readLegacyProjectInventory<T>(source)
  if (input.cache.read() === undefined && legacy.length > 0) {
    input.cache.write(input.sanitize ? legacy.map(input.sanitize) : legacy)
  }
  try {
    source.removeItem?.(LEGACY_PROJECT_INVENTORY_STORAGE_KEY)
  } catch {
    return legacy
  }
  return legacy
}

export function useProjectInventoryActions() {
  const source = useQueryOptions()
  return {
    query: () => projectInventoryQuery({ source }),
    queryKey: () => projectInventoryQueryKey({ source }),
  }
}
