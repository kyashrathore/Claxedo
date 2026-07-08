import { id, now, updateArena } from "./page-arena-store"

type ArenaRuntime = {
  processing: boolean
  paused: boolean
  abort: AbortController
}

const runtimes = new Map<string, ArenaRuntime>()
const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>()

export function arenaRuntime(arenaID: string) {
  const existing = runtimes.get(arenaID)
  if (existing) return existing
  const created: ArenaRuntime = {
    processing: false,
    paused: false,
    abort: new AbortController(),
  }
  runtimes.set(arenaID, created)
  return created
}

export function emitArenaEvent(arenaID: string, event: Record<string, unknown>) {
  const set = listeners.get(arenaID)
  if (!set || set.size === 0) return
  const payload = {
    id: id("evt"),
    arena_id: arenaID,
    ts: now(),
    ...event,
  }
  for (const fn of set.values()) fn(payload)
}

export function onArenaEvent(arenaID: string, fn: (event: Record<string, unknown>) => void) {
  let set = listeners.get(arenaID)
  if (!set) {
    set = new Set()
    listeners.set(arenaID, set)
  }
  set.add(fn)
  return () => {
    set?.delete(fn)
    if (set && set.size === 0) listeners.delete(arenaID)
  }
}

export async function waitPaused(arenaID: string, runtime: ArenaRuntime) {
  while (runtime.paused && !runtime.abort.signal.aborted) {
    updateArena(arenaID, { status: "paused" })
    emitArenaEvent(arenaID, { type: "arena.status", status: "paused" })
    await wait(200)
  }
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
