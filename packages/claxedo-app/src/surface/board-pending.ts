import type { DataPath } from "./model"

export type BoardMove = {
  readonly itemId: string
  readonly fromColumn: string
  readonly fromIndex: number
  readonly toColumn: string
  readonly toIndex: number
}

export type BoardEntry = { readonly id: string; readonly path: DataPath; readonly keyed: boolean }

export type BoardLane = { readonly key: string; readonly path: DataPath; readonly entries: readonly BoardEntry[] }

export type BoardLaneSource = { readonly key: string; readonly path: DataPath; readonly items: readonly unknown[] }

function itemKeyValue(item: unknown, itemKey: string): string | undefined {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined
  const value: unknown = Reflect.get(item, itemKey)
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined
}

function laneEntries(source: BoardLaneSource, itemKey: string, seen: Set<string>): BoardEntry[] {
  return source.items.map((item, index) => {
    const path = [...source.path, String(index)]
    const id = itemKeyValue(item, itemKey)
    if (id === undefined || seen.has(id)) return { id: `${source.key}#${index}`, path, keyed: false }
    seen.add(id)
    return { id, path, keyed: true }
  })
}

function applyMove(lanes: readonly BoardLane[], move: BoardMove): readonly BoardLane[] {
  const moved = lanes.flatMap((lane) => lane.entries).find((entry) => entry.keyed && entry.id === move.itemId)
  if (!moved || !lanes.some((lane) => lane.key === move.toColumn)) return lanes
  return lanes.map((lane) => {
    const kept = lane.entries.filter((entry) => entry !== moved)
    if (lane.key !== move.toColumn) return kept.length === lane.entries.length ? lane : { ...lane, entries: kept }
    const at = Math.min(Math.max(move.toIndex, 0), kept.length)
    return { ...lane, entries: [...kept.slice(0, at), moved, ...kept.slice(at)] }
  })
}

export function arrangeBoard(sources: readonly BoardLaneSource[], itemKey: string, move: BoardMove | undefined): readonly BoardLane[] {
  const seen = new Set<string>()
  const lanes = sources.map((source) => ({ key: source.key, path: source.path, entries: laneEntries(source, itemKey, seen) }))
  return move ? applyMove(lanes, move) : lanes
}

function isPathWithin(path: DataPath, prefix: DataPath): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment)
}

export function patchSettlesMove(patched: DataPath, move: BoardMove, lanes: readonly BoardLaneSource[]): boolean {
  return lanes
    .filter((lane) => lane.key === move.fromColumn || lane.key === move.toColumn)
    .some((lane) => isPathWithin(patched, lane.path) || isPathWithin(lane.path, patched))
}
