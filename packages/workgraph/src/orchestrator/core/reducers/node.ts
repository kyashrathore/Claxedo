import type { EventEnvelope } from "../../events";

export interface NodeState {
  nodes: Record<string, { kind: string; status: string; role: string; retry_count: number }>;
}

export const nodeReducer = (state: NodeState, event: EventEnvelope): NodeState => {
  switch (event.type) {
    case "node_created": {
      try {
        const payload = JSON.parse(event.payload_json);
        return {
          ...state,
          nodes: {
            ...state.nodes,
            [payload.node_id]: {
              kind: payload.kind,
              status: "pending",
              role: payload.role || "developer",
              retry_count: 0,
            }
          }
        };
      } catch (e) {
        console.warn(`Failed to parse node_created payload for event ${event.id}`);
        return state;
      }
    }
    case "node_status_changed": {
      try {
        const payload = JSON.parse(event.payload_json);
        const node = state.nodes[payload.node_id];
        if (!node) return state;
        return {
          ...state,
          nodes: {
            ...state.nodes,
            [payload.node_id]: {
              ...node,
              status: payload.status,
              retry_count: payload.status === "retryable" ? node.retry_count + 1 : node.retry_count,
            }
          }
        };
      } catch (e) {
        console.warn(`Failed to parse node_status_changed payload for event ${event.id}`);
        return state;
      }
    }
    default:
      return state;
  }
};
