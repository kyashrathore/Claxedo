import type {
  ExternalReference,
  IntakeActivity,
  IntakeItem,
  LoadoutSlot,
  ReviewBatch,
  ReviewableDecision,
  WorkEdge,
  WorkEvent,
  WorkGraphState,
  WorkItem,
  ScratchpadEntry,
} from "./types"

function itemPayload(payload: unknown): WorkItem {
  return payload && typeof payload === "object" && "item" in payload
    ? (payload as { item: WorkItem }).item
    : payload as WorkItem
}

function edgePayload(payload: unknown): WorkEdge {
  return payload && typeof payload === "object" && "edge" in payload
    ? (payload as { edge: WorkEdge }).edge
    : payload as WorkEdge
}

export function emptyState(): WorkGraphState {
  return {
    items: {},
    edges: [],
    scratchpads: [],
    intakeItems: {},
    intakeActivities: [],
    externalReferences: {},
    decisions: {},
    batches: {},
    loadoutSlots: {},
  }
}

export function reduce(state: WorkGraphState, event: WorkEvent): WorkGraphState {
  const payload = JSON.parse(event.payload)

  switch (event.type) {
    case "item_created":
    case "item_hydrated": {
      const item = itemPayload(payload)
      return {
        ...state,
        items: {
          ...state.items,
          [item.id]: {
            ...item,
            parentId: item.parentId ?? null,
            nodeType: item.nodeType ?? "task",
          },
        },
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
        ...state,
        items: rest,
        edges: state.edges.filter((e) => e.source !== id && e.target !== id),
      }
    }

    case "edge_added": {
      const edge = edgePayload(payload)
      return {
        ...state,
        edges: [...state.edges, edge],
      }
    }

    case "edge_removed": {
      const { source, target } = edgePayload(payload)
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

    case "intake_item_created": {
      const item = payload as IntakeItem
      return {
        ...state,
        intakeItems: {
          ...state.intakeItems,
          [item.id]: item,
        },
      }
    }

    case "intake_item_updated": {
      const { id, changes } = payload as { id: string; changes: Partial<IntakeItem> }
      const existing = state.intakeItems[id]
      if (!existing) return state
      return {
        ...state,
        intakeItems: {
          ...state.intakeItems,
          [id]: { ...existing, ...changes },
        },
      }
    }

    case "intake_activity_appended": {
      const activity = payload as IntakeActivity
      if (state.intakeActivities.some((item) => item.id === activity.id)) return state
      return {
        ...state,
        intakeActivities: [...state.intakeActivities, activity],
      }
    }

    case "external_reference_linked": {
      const reference = payload as ExternalReference
      return {
        ...state,
        externalReferences: {
          ...state.externalReferences,
          [reference.id]: reference,
        },
      }
    }

    case "external_reference_unlinked": {
      const { id } = payload as { id: string }
      const { [id]: _, ...rest } = state.externalReferences
      return {
        ...state,
        externalReferences: rest,
      }
    }

    case "decision_created": {
      const decision = payload as ReviewableDecision
      return {
        ...state,
        decisions: {
          ...state.decisions,
          [decision.id]: decision,
        },
      }
    }

    case "decision_resolved": {
      const next = payload as { id: string } & Partial<ReviewableDecision>
      const existing = state.decisions[next.id]
      if (!existing) return state
      return {
        ...state,
        decisions: {
          ...state.decisions,
          [next.id]: { ...existing, ...next },
        },
      }
    }

    case "decision_snoozed": {
      const { id } = payload as { id: string }
      const existing = state.decisions[id]
      if (!existing) return state
      return {
        ...state,
        decisions: {
          ...state.decisions,
          [id]: { ...existing, status: "snoozed" },
        },
      }
    }

    case "decision_expired": {
      const { id, status, resolvedAt } = payload as { id: string; status?: ReviewableDecision["status"]; resolvedAt?: string | null }
      const existing = state.decisions[id]
      if (!existing) return state
      return {
        ...state,
        decisions: {
          ...state.decisions,
          [id]: { ...existing, status: status ?? "expired", resolvedAt: resolvedAt ?? existing.resolvedAt },
        },
      }
    }

    case "review_batch_submitted": {
      const batch = payload as ReviewBatch
      return {
        ...state,
        batches: {
          ...state.batches,
          [batch.id]: batch,
        },
      }
    }

    case "loadout_slot_set": {
      const slot = payload as LoadoutSlot
      return {
        ...state,
        loadoutSlots: {
          ...state.loadoutSlots,
          [slot.id]: slot,
        },
      }
    }

    case "loadout_slot_cleared": {
      const { id } = payload as { id: string }
      const { [id]: _, ...rest } = state.loadoutSlots
      return {
        ...state,
        loadoutSlots: rest,
      }
    }

    case "captain_proposed":
    case "captain_failed":
      return state

    default:
      return state
  }
}

export function replayEvents(events: WorkEvent[]): WorkGraphState {
  return events.reduce(reduce, emptyState())
}
