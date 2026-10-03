import type { Machine } from "@/lib/machine"
import { toAppError, type SessionActivityFilter } from "@/server"
import { readInventoryPages, type InventoryServer } from "./inventory-pages"
import type { InventoryEvent, InventoryWindow } from "./inventory-model"
import type { ListEvent, ListState } from "./model"

export type InventoryQueryKey = "active" | "shared"
export type InventoryWindows = Record<InventoryQueryKey, Machine<InventoryWindow, InventoryEvent>>

function query(key: InventoryQueryKey, activity: SessionActivityFilter, after?: string) {
  return { settled: "active", ...(key === "active" && activity !== "all" ? { activity } : {}), ...(key === "shared" ? { ownership: "shared" as const } : {}), limit: 25, after } as const
}

async function readPage(server: InventoryServer, list: Machine<ListState, ListEvent>, windows: InventoryWindows, key: InventoryQueryKey, more: boolean, activity: SessionActivityFilter): Promise<void> {
  const window = windows[key]
  const before = window.state()
  const after = more ? before.after : undefined
  if (more && !after) return
  window.send({ type: "requested" })
  const revision = window.state().revision
  const sentAt = Date.now()
  try {
    const page = await readInventoryPages(server, query(key, activity, after), more ? 25 : Math.max(25, before.refs.length))
    if (window.state().revision !== revision) return
    const count = page.totalKnown
    window.send({ type: "received", revision, more, page: { refs: page.rows.map((row) => row.ref), count, after: page.nextAfter, degraded: page.degraded === true } })
    const ids = new Set(Object.values(windows).flatMap((window) => window.state().refs.map((ref) => ref.sessionId)))
    list.send({ type: "inventoryRead", rows: page.rows, statuses: page.statuses, sentAt, ids })
  } catch (cause) { window.send({ type: "failed", revision, error: toAppError(cause) }) }
}

export function createInventoryReads(server: InventoryServer, list: Machine<ListState, ListEvent>, windows: InventoryWindows, activity: () => SessionActivityFilter = () => "all") {
  const active = new Map<InventoryQueryKey, Promise<void>>()
  const queued = new Set<InventoryQueryKey>()
  const read = (key: InventoryQueryKey, more = false): Promise<void> => {
    const running = active.get(key)
    if (running) {
      if (!more) { queued.add(key); windows[key].send({ type: "invalidated" }) }
      return running
    }
    const promise = readPage(server, list, windows, key, more, activity()).then(async () => {
      active.delete(key)
      if (queued.delete(key)) await read(key)
    })
    active.set(key, promise)
    return promise
  }
  return { read }
}
