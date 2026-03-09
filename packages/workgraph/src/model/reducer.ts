import type { WorkGraphState, WorkEvent, WorkItem, WorkEdge, ScratchpadEntry } from "./types"

export function emptyState(): WorkGraphState {
  return { items: {}, edges: [], scratchpads: [] }
}

export function reduce(state: WorkGraphState, event: WorkEvent): WorkGraphState {
  const payload = JSON.parse(event.payload)

  switch (event.type) {
    case "item_created":
    case "item_hydrated": {
      const item = payload as WorkItem
      return {
        ...state,
        items: { ...state.items, [item.id]: item },
      }
    }

    case "item_updated": {
      const { id, changes } = payload as { id: string; changes: Partial<WorkItem> }
      const existing = state.items[id]
      if (!existing) return state
      return {
        ...state,
        items: {
          ...state.items,
          [id]: { ...existing, ...changes },
        },
      }
    }

    case "item_removed": {
      const { id } = payload as { id: string }
      const { [id]: _, ...rest } = state.items
      return {
        items: rest,
        edges: state.edges.filter((e) => e.source !== id && e.target !== id),
        scratchpads: state.scratchpads,
      }
    }

    case "edge_added": {
      const edge = payload as WorkEdge
      return {
        ...state,
        edges: [...state.edges, edge],
      }
    }

    case "edge_removed": {
      const { source, target } = payload as WorkEdge
      return {
        ...state,
        edges: state.edges.filter((e) => !(e.source === source && e.target === target)),
      }
    }

    case "item_synced": {
      const { id, changes } = payload as { id: string; changes: Partial<WorkItem> }
      const existing = state.items[id]
      if (!existing) return state
      return {
        ...state,
        items: {
          ...state.items,
          [id]: { ...existing, ...changes },
        },
      }
    }

    case "scratchpad_written": {
      const entry = payload as ScratchpadEntry
      return {
        ...state,
        scratchpads: [...state.scratchpads, entry],
      }
    }

    case "scratchpad_promoted": {
      const { scratchpadId, promotedToItemId } = payload as { scratchpadId: string; promotedToItemId: string }
      return {
        ...state,
        scratchpads: state.scratchpads.map((s) =>
          s.id === scratchpadId ? { ...s, promotedToItemId } : s,
        ),
      }
    }

    case "scratchpad_dismissed": {
      const { scratchpadId, dismissedAt } = payload as { scratchpadId: string; dismissedAt: string }
      return {
        ...state,
        scratchpads: state.scratchpads.map((s) =>
          s.id === scratchpadId ? { ...s, dismissedAt } : s,
        ),
      }
    }

    default:
      return state
  }
}

export function replayEvents(events: WorkEvent[]): WorkGraphState {
  return events.reduce(reduce, emptyState())
}

