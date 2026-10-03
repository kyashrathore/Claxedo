import { unreachable } from "@/lib/machine"
import type { AppError, SessionLocation } from "@/server"

type PageData = { readonly refs: readonly SessionLocation[]; readonly count: number; readonly after?: string; readonly degraded: boolean }
export type InventoryWindow = PageData & { readonly revision: number } & (
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly error: AppError }
)
export type InventoryEvent =
  | { readonly type: "filterChanged" }
  | { readonly type: "requested" }
  | { readonly type: "invalidated" }
  | { readonly type: "received"; readonly revision: number; readonly page: PageData; readonly more: boolean }
  | { readonly type: "failed"; readonly revision: number; readonly error: AppError }

export const EMPTY_INVENTORY: InventoryWindow = { kind: "idle", revision: 0, refs: [], count: 0, degraded: false }

export function inventoryTransition(state: InventoryWindow, event: InventoryEvent): InventoryWindow {
  switch (event.type) {
    case "filterChanged": return { ...EMPTY_INVENTORY, revision: state.revision + 1 }
    case "invalidated": return { ...state, revision: state.revision + 1 }
    case "requested": return { ...state, kind: "loading", revision: state.revision + 1 }
    case "received": {
      if (state.revision !== event.revision) return state
      const refs = event.more ? [...new Map([...state.refs, ...event.page.refs].map((ref) => [ref.sessionId, ref])).values()] : event.page.refs
      return { kind: "ready", revision: state.revision, ...event.page, refs }
    }
    case "failed": return state.revision === event.revision ? { ...state, kind: "failed", error: event.error } : state
    default: return unreachable(event)
  }
}
