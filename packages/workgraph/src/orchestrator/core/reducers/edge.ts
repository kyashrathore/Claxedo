import type { EventEnvelope } from "../../events";

export interface EdgeState {
  edges: Array<{ id: string; source_id: string; target_id: string; type: string }>;
}

export const edgeReducer = (state: EdgeState, event: EventEnvelope): EdgeState => {
  switch (event.type) {
    case "edge_added": {
      try {
        const payload = JSON.parse(event.payload_json);
        return {
          ...state,
          edges: [
            ...state.edges,
            {
              id: payload.id,
              source_id: payload.source_id,
              target_id: payload.target_id,
              type: payload.type,
            }
          ]
        };
      } catch (e) {
        console.warn(`Failed to parse edge_added payload for event ${event.id}`);
        return state;
      }
    }
    case "edge_removed": {
      try {
        const payload = JSON.parse(event.payload_json);
        return {
          ...state,
          edges: state.edges.filter(edge => edge.id !== payload.id),
        };
      } catch (e) {
        console.warn(`Failed to parse edge_removed payload for event ${event.id}`);
        return state;
      }
    }
    default:
      return state;
  }
};
