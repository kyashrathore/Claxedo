import { compareListOrder, encodeListAfter, listOrderKey, type ListOrderKey } from "./wire/list-order"

export type SourcePage = { readonly items: readonly unknown[]; readonly nextAfter?: string }

export type SessionSource = {
  readonly required: boolean
  readonly read: (after: string | undefined) => Promise<SourcePage>
}

export type MergedPage = { readonly items: readonly unknown[]; readonly nextAfter?: string; readonly degraded: boolean }

type Keyed = { readonly key: ListOrderKey; readonly item: unknown }

function keyed(items: readonly unknown[]): Keyed[] {
  return items.flatMap((item) => {
    const key = listOrderKey(item)
    return key ? [{ key, item }] : []
  })
}

export async function readSessionSources(sources: readonly SessionSource[], limit: number, after: string | undefined): Promise<MergedPage> {
  const pages = await Promise.all(sources.map(async (source) => {
    try {
      return await source.read(after)
    } catch (error) {
      if (source.required) throw error
      return undefined
    }
  }))
  const union = new Map<string, Keyed>()
  for (const entry of pages.flatMap((page) => keyed(page?.items ?? []))) {
    if (!union.has(entry.key.sessionRef)) union.set(entry.key.sessionRef, entry)
  }
  const ordered = [...union.values()].sort((a, b) => compareListOrder(a.key, b.key))
  const shown = ordered.slice(0, limit)
  const last = shown.at(-1)
  const more = ordered.length > limit || pages.some((page) => page?.nextAfter !== undefined)
  return {
    items: shown.map((entry) => entry.item),
    ...(more && last ? { nextAfter: encodeListAfter(last.key) } : {}),
    degraded: pages.includes(undefined),
  }
}
