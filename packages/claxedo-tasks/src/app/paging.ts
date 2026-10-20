import type { TasksClient } from "../client/client"
import type { Preset } from "../contracts"

type CursorPage<T> = { readonly items: readonly T[]; readonly nextCursor?: string | null }

export async function allPages<T>(read: (cursor: string | null) => Promise<CursorPage<T>>): Promise<T[]> {
  const items: T[] = []
  let cursor: string | null = null
  do {
    const page = await read(cursor)
    items.push(...page.items)
    cursor = page.nextCursor ?? null
  } while (cursor)
  return items
}

export function allPresets(client: TasksClient, includeArchived: boolean): Promise<Preset[]> {
  return allPages((cursor) => client.listPresets({ includeArchived, cursor }))
}
