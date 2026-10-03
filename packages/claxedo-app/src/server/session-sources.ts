import { readString } from "@claxedo/helpers/readers"
import { compareListOrder, encodeListAfter, listOrderKey, type ListOrderKey } from "./wire/list-order"

export type SourcePage = { readonly items: readonly unknown[]; readonly nextAfter?: string }

export type SessionSource = {
  readonly required: boolean
  readonly read: (after: string | undefined) => Promise<SourcePage>
}

export type MergedPage = { readonly items: readonly unknown[]; readonly nextAfter?: string; readonly degraded: boolean }

type Keyed = { readonly key: ListOrderKey; readonly item: unknown; readonly identity: string }

type Round = { readonly ordered: readonly Keyed[]; readonly exhausted: boolean; readonly degraded: boolean }

function sessionIdentity(item: unknown, key: ListOrderKey): string {
  const workspaceId = readString(item, "workspaceId")
  const sessionId = readString(item, "sessionId")
  return workspaceId !== undefined && sessionId !== undefined ? `${workspaceId}\u0000${sessionId}` : key.sessionRef
}

function keyed(items: readonly unknown[]): Keyed[] {
  return items.flatMap((item) => {
    const key = listOrderKey(item)
    return key ? [{ key, item, identity: sessionIdentity(item, key) }] : []
  })
}

async function readRound(sources: readonly SessionSource[], after: string | undefined): Promise<Round> {
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
    if (!union.has(entry.identity)) union.set(entry.identity, entry)
  }
  return {
    ordered: [...union.values()].sort((a, b) => compareListOrder(a.key, b.key)),
    exhausted: pages.every((page) => page?.nextAfter === undefined),
    degraded: pages.includes(undefined),
  }
}

export type MergeOptions = { readonly fill: boolean; readonly hidden?: (item: unknown) => boolean }

export async function readSessionSources(sources: readonly SessionSource[], limit: number, after: string | undefined, options: MergeOptions): Promise<MergedPage> {
  const hidden = options.hidden ?? (() => false)
  const shown: Keyed[] = []
  const examined = new Set<string>()
  let degraded = false
  let cursor = after
  for (;;) {
    const round = await readRound(sources, cursor)
    degraded ||= round.degraded
    const window = round.ordered.slice(0, limit).filter((entry) => !examined.has(entry.identity))
    for (const entry of window) {
      examined.add(entry.identity)
      if (!hidden(entry.item)) shown.push(entry)
      if (shown.length < limit) continue
      const more = entry !== round.ordered.at(-1) || !round.exhausted
      return { items: shown.map((kept) => kept.item), ...(more ? { nextAfter: encodeListAfter(entry.key) } : {}), degraded }
    }
    const last = window.at(-1)
    if (!last || (round.ordered.length <= limit && round.exhausted)) return { items: shown.map((kept) => kept.item), degraded }
    if (!options.fill) return { items: shown.map((kept) => kept.item), nextAfter: encodeListAfter(last.key), degraded }
    cursor = encodeListAfter(last.key)
  }
}
