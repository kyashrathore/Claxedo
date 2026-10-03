import { machine } from "@/lib/machine"
import { placementId, projectId, sessionId, type SessionInventoryInput, type SessionInventoryPage, type SessionRow } from "@/server"
import type { InventoryServer } from "./inventory-pages"
import { EMPTY_INVENTORY, inventoryTransition } from "./inventory-model"
import type { InventoryWindows } from "./inventory-reads"
import { initialListState } from "./model"
import { listTransition } from "./transition"

export function inventoryRow(id: string, createdAt = 1): SessionRow {
  return {
    ref: { projectId: projectId("prj_inventory"), placementId: placementId("plc_inventory"), sessionId: sessionId(id) },
    title: id,
    executionAvailability: { status: "available" },
    createdAt,
    updatedAt: createdAt,
    attention: { generation: 1, sequence: 1, activitySequence: 1, activityAt: createdAt, working: false, awaitingInput: false },
  }
}

export function inventoryPage(rows: readonly SessionRow[], nextAfter?: string): SessionInventoryPage {
  return { rows, statuses: new Map(), totalKnown: 109, nextAfter }
}

export function inventoryServer(read: (input: SessionInventoryInput) => Promise<SessionInventoryPage>): InventoryServer {
  return { sessions: { inventory: read } }
}

export function inventoryTestState() {
  const list = machine({ ...initialListState, kind: "live" as const, more: new Map() }, listTransition)
  const windows: InventoryWindows = { active: machine(EMPTY_INVENTORY, inventoryTransition), shared: machine(EMPTY_INVENTORY, inventoryTransition) }
  return { list, windows }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((ready) => { resolve = ready })
  return { promise, resolve }
}
