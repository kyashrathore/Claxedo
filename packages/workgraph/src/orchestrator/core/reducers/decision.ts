import type { EventEnvelope } from "../../events";

export interface DecisionState {
  decisions: Record<string, { proposal: string; status: string; challenger_id?: string }>;
}

export const decisionReducer = (state: DecisionState, event: EventEnvelope): DecisionState => {
  switch (event.type) {
    case "decision_proposed": {
      try {
        const payload = JSON.parse(event.payload_json);
        return {
          ...state,
          decisions: {
            ...state.decisions,
            [payload.id]: {
              proposal: payload.proposal,
              status: "proposed",
            }
          }
        };
      } catch (e) {
        console.warn(`Failed to parse decision_proposed payload for event ${event.id}`);
        return state;
      }
    }
    case "decision_challenged": {
      try {
        const payload = JSON.parse(event.payload_json);
        const decision = state.decisions[payload.id];
        if (!decision) return state;
        return {
          ...state,
          decisions: {
            ...state.decisions,
            [payload.id]: {
              ...decision,
              status: "challenged",
              challenger_id: payload.challenger_id,
            }
          }
        };
      } catch (e) {
        console.warn(`Failed to parse decision_challenged payload for event ${event.id}`);
        return state;
      }
    }
    case "decision_accepted": {
      try {
        const payload = JSON.parse(event.payload_json);
        const decision = state.decisions[payload.id];
        if (!decision) return state;
        return {
          ...state,
          decisions: {
            ...state.decisions,
            [payload.id]: {
              ...decision,
              status: "accepted",
            }
          }
        };
      } catch (e) {
        console.warn(`Failed to parse decision_accepted payload for event ${event.id}`);
        return state;
      }
    }
    case "decision_rejected": {
      try {
        const payload = JSON.parse(event.payload_json);
        const decision = state.decisions[payload.id];
        if (!decision) return state;
        return {
          ...state,
          decisions: {
            ...state.decisions,
            [payload.id]: {
              ...decision,
              status: "rejected",
            }
          }
        };
      } catch (e) {
        console.warn(`Failed to parse decision_rejected payload for event ${event.id}`);
        return state;
      }
    }
    default:
      return state;
  }
};
