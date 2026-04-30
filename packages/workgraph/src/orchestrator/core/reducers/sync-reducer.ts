import type { EventEnvelope } from "../../events";

export interface SyncReducerState {
  pushes: string[];
  pulls: string[];
  conflicts: string[];
  snapshots: string[];
  repairs: string[];
}

export const syncReducer = (state: SyncReducerState, event: EventEnvelope): SyncReducerState => {
  switch (event.type) {
    case "sync_push_acked": {
      try {
        const payload = JSON.parse(event.payload_json);
        return {
          ...state,
          pushes: [...state.pushes, payload.id],
        };
      } catch (e) {
        console.warn(`Failed to parse sync_push_acked payload for event ${event.id}`);
        return state;
      }
    }
    case "sync_pull_applied": {
      try {
        const payload = JSON.parse(event.payload_json);
        return {
          ...state,
          pulls: [...state.pulls, payload.id],
        };
      } catch (e) {
        console.warn(`Failed to parse sync_pull_applied payload for event ${event.id}`);
        return state;
      }
    }
    case "conflict_detected": {
      try {
        const payload = JSON.parse(event.payload_json);
        return {
          ...state,
          conflicts: [...state.conflicts, payload.id],
        };
      } catch (e) {
        console.warn(`Failed to parse conflict_detected payload for event ${event.id}`);
        return state;
      }
    }
    case "conflict_resolved": {
      try {
        const payload = JSON.parse(event.payload_json);
        // Update conflicts list — keep existing entries, resolution noted
        return {
          ...state,
          conflicts: state.conflicts.map(c => c === payload.id ? `${c}:resolved` : c),
        };
      } catch (e) {
        console.warn(`Failed to parse conflict_resolved payload for event ${event.id}`);
        return state;
      }
    }
    case "snapshot_created": {
      try {
        const payload = JSON.parse(event.payload_json);
        return {
          ...state,
          snapshots: [...state.snapshots, payload.id],
        };
      } catch (e) {
        console.warn(`Failed to parse snapshot_created payload for event ${event.id}`);
        return state;
      }
    }
    case "repair_rebuild_completed": {
      try {
        const payload = JSON.parse(event.payload_json);
        return {
          ...state,
          repairs: [...state.repairs, payload.id],
        };
      } catch (e) {
        console.warn(`Failed to parse repair_rebuild_completed payload for event ${event.id}`);
        return state;
      }
    }
    default:
      return state;
  }
};
