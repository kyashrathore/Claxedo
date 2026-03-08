import type { EventEnvelope } from "../../events";

export interface HandoffState {
  handoffs: Record<string, { from_team: string; to_team: string; status: string }>;
}

export const handoffReducer = (state: HandoffState, event: EventEnvelope): HandoffState => {
  switch (event.type) {
    case "handoff_requested": {
      try {
        const payload = JSON.parse(event.payload_json);
        return {
          ...state,
          handoffs: {
            ...state.handoffs,
            [payload.id]: {
              from_team: payload.from_team_id,
              to_team: payload.to_team_id,
              status: "pending",
            }
          }
        };
      } catch (e) {
        console.warn(`Failed to parse handoff_requested payload for event ${event.id}`);
        return state;
      }
    }
    case "handoff_accepted": {
      try {
        const payload = JSON.parse(event.payload_json);
        const handoff = state.handoffs[payload.id];
        if (!handoff) return state;
        return {
          ...state,
          handoffs: {
            ...state.handoffs,
            [payload.id]: {
              ...handoff,
              status: "accepted",
            }
          }
        };
      } catch (e) {
        console.warn(`Failed to parse handoff_accepted payload for event ${event.id}`);
        return state;
      }
    }
    case "handoff_rejected": {
      try {
        const payload = JSON.parse(event.payload_json);
        const handoff = state.handoffs[payload.id];
        if (!handoff) return state;
        return {
          ...state,
          handoffs: {
            ...state.handoffs,
            [payload.id]: {
              ...handoff,
              status: "rejected",
            }
          }
        };
      } catch (e) {
        console.warn(`Failed to parse handoff_rejected payload for event ${event.id}`);
        return state;
      }
    }
    default:
      return state;
  }
};
